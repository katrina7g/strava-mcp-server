import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadConfig, type ServerConfig } from "./config.js";
import { aggregateTraining, getActivity, getArchiveSummary, getDataSchema, searchActivities } from "./archive.js";
import { importActivityCatalog } from "./catalog.js";
import { closeDatabase, openDatabase, type Database } from "./database.js";
import { guardTool, logInternalError, toolFailure, toolSuccess, type ToolResult } from "./errors.js";
import { getActivityRoute, getActivityStream, importDetailedActivityFiles } from "./details.js";
import { getGear, importGear } from "./gear.js";
import { MAX_GROUPS } from "./limits.js";
import { analyzeActivity, compareTrainingPeriods, getPersonalBests, getSportSummary, getTrainingLoad, listSports } from "./training.js";
import { validateExport } from "./validator.js";

const SERVER_NAME = "strava-mcp-server";
const SERVER_VERSION = "1.0.0";
const MAX_TOOL_FINDINGS = 50;
const MAX_PAGE_SIZE = 100;
const MAX_STREAM_POINTS = 1_000;
const MAX_ROUTE_POINTS = 1_000;

const optionalDate = z.string().datetime().optional();
const optionalFiniteNumber = z.number().finite().optional();
const trainingMetrics = z.enum(["activityCount", "distanceMeters", "durationSeconds", "elevationGainMeters", "averagePaceSecondsPerKm", "averageHeartRate", "averageWatts", "relativeEffort"]);
const trainingFilterSchema = z.object({
  sports: z.array(z.string().trim().min(1)).max(20).optional(), startDate: optionalDate, endDate: optionalDate,
}).refine((input) => input.startDate === undefined || input.endDate === undefined || input.startDate < input.endDate, { message: "startDate must be before endDate." });
/** Calendar buckets follow local time by default; instants filter in UTC. */
const timeBasis = z.enum(["local", "utc"]).optional();
/** Grouped results are capped so a long history cannot flood a response. */
const maxGroups = z.number().int().min(1).max(MAX_GROUPS).optional();

/**
 * Creates the server without opening a transport, which keeps the entry point
 * usable by future functional tests.
 */
export function createServer(config: ServerConfig = loadConfig()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "get_server_info",
    {
      title: "Get server information",
      description: "Returns the Strava MCP server identity and current mode.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: SERVER_NAME,
            version: SERVER_VERSION,
            mode: "local-read-only",
            exportConfigured: config.exportDir !== undefined,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "import_detailed_activities",
    {
      title: "Import detailed activities",
      description: "Decodes linked GPX, FIT, compressed FIT, and compressed TCX files into the local database. Source files are never changed; per-file failures do not stop the remaining import.",
      inputSchema: z.object({ activityId: z.string().trim().min(1).optional() }),
    },
    async ({ activityId }) => withExport(config, "import_detailed_activities", (exportDir, database) => importDetailedActivityFiles(exportDir, database, activityId, config.timeZone)),
  );

  server.registerTool(
    "get_activity_stream",
    {
      title: "Get activity stream", description: "Returns bounded imported telemetry. Coordinates are withheld unless includeLocation is explicitly true, and that opt-in applies only to the single request that sets it.",
      inputSchema: z.object({
        activityId: z.string().trim().min(1), fields: z.array(z.enum(["timestamp", "altitudeMeters", "distanceMeters", "heartRate", "cadence", "powerWatts", "speedMetersPerSecond", "latitude", "longitude"])).max(9).optional(),
        includeLocation: z.boolean().default(false),
        maxPoints: z.number().int().min(1).max(MAX_STREAM_POINTS).optional(), startTime: optionalDate, endTime: optionalDate,
      }).refine((input) => input.startTime === undefined || input.endTime === undefined || input.startTime < input.endTime, { message: "startTime must be before endTime." }),
    },
    async ({ activityId, fields, includeLocation, maxPoints, startTime, endTime }) => withDatabase(config, "get_activity_stream", (database) => getActivityStream(database, activityId, fields ?? [], includeLocation, maxPoints ?? 250, startTime, endTime)),
  );

  server.registerTool(
    "get_activity_route",
    {
      title: "Get activity route", description: "Returns a privacy-preserving route summary by default, or a bounded simplified GeoJSON LineString when includeLocation is explicitly true.",
      inputSchema: z.object({ activityId: z.string().trim().min(1), includeLocation: z.boolean().default(false), maxPoints: z.number().int().min(2).max(MAX_ROUTE_POINTS).optional() }),
    },
    async ({ activityId, includeLocation, maxPoints }) => withDatabase(config, "get_activity_route", (database) => getActivityRoute(database, activityId, includeLocation, maxPoints ?? 250)),
  );

  server.registerTool(
    "list_sports",
    { title: "List sports", description: "Lists sports present in the imported catalog with coverage and metric availability.", inputSchema: trainingFilterSchema },
    async (input) => withDatabase(config, "list_sports", (database) => listSports(database, input)),
  );

  server.registerTool(
    "get_sport_summary",
    {
      title: "Get sport summary", description: "Summarizes one sport over time using imported catalog metrics.",
      inputSchema: trainingFilterSchema.extend({ sport: z.string().trim().min(1), groupBy: z.enum(["week", "month", "year"]).optional(), timeBasis, maxGroups }),
    },
    async (input) => withDatabase(config, "get_sport_summary", (database) => getSportSummary(database, input)),
  );

  server.registerTool(
    "compare_training_periods",
    {
      title: "Compare training periods", description: "Compares allowlisted catalog metrics across two date ranges.",
      inputSchema: z.object({
        sports: z.array(z.string().trim().min(1)).max(20).optional(),
        baselineStart: z.string().datetime(), baselineEnd: z.string().datetime(),
        comparisonStart: z.string().datetime(), comparisonEnd: z.string().datetime(),
        metrics: z.array(trainingMetrics).min(1).max(8).optional(),
      }).refine((input) => input.baselineStart < input.baselineEnd && input.comparisonStart < input.comparisonEnd, { message: "Each period start must be before its end." }),
    },
    async (input) => withDatabase(config, "compare_training_periods", (database) => compareTrainingPeriods(database, input)),
  );

  server.registerTool(
    "get_personal_bests",
    {
      title: "Get personal bests", description: "Returns catalog-derived best activities for one sport with documented definitions.",
      inputSchema: trainingFilterSchema.extend({
        sport: z.string().trim().min(1), metric: z.enum(["distanceMeters", "averagePaceSecondsPerKm", "elevationGainMeters", "averageWatts"]),
        minDistanceMeters: optionalFiniteNumber, maxDistanceMeters: optionalFiniteNumber, minDurationSeconds: optionalFiniteNumber,
        limit: z.number().int().min(1).max(20).optional(),
      }),
    },
    async (input) => withDatabase(config, "get_personal_bests", (database) => getPersonalBests(database, input)),
  );

  server.registerTool(
    "analyze_activity",
    {
      title: "Analyze activity", description: "Provides catalog-level activity analysis. Split-based pacing and telemetry progression are not implemented; decoded telemetry is available through get_activity_stream and get_activity_route.",
      inputSchema: z.object({ activityId: z.string().trim().min(1), analysisType: z.enum(["catalogSummary", "pace", "intensity"]).default("catalogSummary") }),
    },
    async ({ activityId, analysisType }) => withDatabase(config, "analyze_activity", (database) => analyzeActivity(database, activityId, analysisType)),
  );

  server.registerTool(
    "get_training_load",
    {
      title: "Get training load", description: "Groups supplied or clearly labelled derived training-load proxies.",
      inputSchema: trainingFilterSchema.extend({ groupBy: z.enum(["week", "month", "sport"]).optional(), preference: z.enum(["supplied", "relativeEffort", "duration"]).optional(), timeBasis, maxGroups }),
    },
    async (input) => withDatabase(config, "get_training_load", (database) => getTrainingLoad(database, input)),
  );

  server.registerTool(
    "validate_export",
    {
      title: "Validate Strava export",
      description: "Read-only validation of the configured local Strava export. Records a local validation snapshot but never changes the export.",
      inputSchema: z.object({}),
    },
    async () => withExport(config, "validate_export", async (exportDir, database) => {
      const report = await validateExport(exportDir, database);
      return {
        outcome: report.outcome,
        delta: report.summary,
        findings: report.findings.slice(0, MAX_TOOL_FINDINGS),
        totalFindings: report.findings.length,
        findingsTruncated: report.findings.length > MAX_TOOL_FINDINGS,
      };
    }),
  );

  server.registerTool(
    "import_activity_catalog",
    {
      title: "Import activity catalog",
      description: "Imports the validated activities.csv catalog into the local database. Never changes the source export.",
      inputSchema: z.object({}),
    },
    async () => withExport(config, "import_activity_catalog", async (exportDir, database) => {
      const validation = await validateExport(exportDir, database);
      const snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
      const imported = await importActivityCatalog(exportDir, database, snapshot.id, config.timeZone);
      return { validation: { outcome: validation.outcome, delta: validation.summary }, catalogDelta: imported };
    }),
  );

  server.registerTool(
    "import_supporting_data",
    {
      title: "Import supporting data",
      description: "Imports the export's supporting domains, currently gear, into the local database. Reuses the latest validation snapshot and never changes the source export.",
      inputSchema: z.object({}),
    },
    async () => withExport(config, "import_supporting_data", async (exportDir, database) => {
      const snapshotId = await latestSnapshotId(exportDir, database);
      return { snapshotId, domains: await importGear(exportDir, database, snapshotId) };
    }),
  );

  server.registerTool(
    "get_gear",
    {
      title: "Get gear",
      description: "Lists imported gear with usage counts and distance. Returns an empty, explained result when an export contains no gear.",
      inputSchema: z.object({
        gearType: z.enum(["shoe", "bike", "component"]).optional(),
        page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
      }),
    },
    async (input) => withDatabase(config, "get_gear", (database) => getGear(database, input)),
  );

  server.registerTool(
    "get_archive_summary",
    { title: "Get archive summary", description: "Summarizes imported activity coverage and latest validation health." },
    async () => withDatabase(config, "get_archive_summary", (database) => getArchiveSummary(database)),
  );

  server.registerTool(
    "get_data_schema",
    { title: "Get data schema", description: "Describes available imported fields, units, and privacy classification.", inputSchema: z.object({ domain: z.enum(["activities", "catalog", "gear"]).optional() }) },
    async ({ domain }) => withDatabase(config, "get_data_schema", (database) => getDataSchema(database, domain)),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get activity",
      description: "Returns one activity's catalog metadata, derived metrics, raw-file decode status, and telemetry availability. Never returns coordinates.",
      inputSchema: z.object({ activityId: z.string().trim().min(1) }),
    },
    async ({ activityId }) => withDatabase(config, "get_activity", (database) => getActivity(database, activityId)),
  );

  server.registerTool(
    "search_activities",
    {
      title: "Search activities",
      description: "Searches imported activities with sport, date, metric, and bounded pagination filters.",
      inputSchema: z.object({
        sports: z.array(z.string().trim().min(1)).max(20).optional(), startDate: optionalDate, endDate: optionalDate,
        minDistanceMeters: optionalFiniteNumber, maxDistanceMeters: optionalFiniteNumber,
        minDurationSeconds: optionalFiniteNumber, maxDurationSeconds: optionalFiniteNumber,
        minRelativeEffort: optionalFiniteNumber, text: z.string().trim().max(200).optional(),
        page: z.number().int().min(1).optional(), pageSize: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
        sortBy: z.enum(["startedAt", "distanceMeters", "durationSeconds"]).optional(), sortDirection: z.enum(["asc", "desc"]).optional(),
      }).refine((input) => input.startDate === undefined || input.endDate === undefined || input.startDate < input.endDate, { message: "startDate must be before endDate." }),
    },
    async (input) => withDatabase(config, "search_activities", (database) => searchActivities(database, input)),
  );

  server.registerTool(
    "aggregate_training",
    {
      title: "Aggregate training", description: "Returns allowlisted activity aggregates grouped by day, week, month, or sport.",
      inputSchema: z.object({
        sports: z.array(z.string().trim().min(1)).max(20).optional(), startDate: optionalDate, endDate: optionalDate,
        groupBy: z.enum(["day", "week", "month", "sport"]).optional(), timeBasis, maxGroups,
        metrics: z.array(z.enum(["activityCount", "distanceMeters", "durationSeconds", "elevationGainMeters", "averageHeartRate", "averageWatts", "relativeEffort"])).min(1).max(7).optional(),
      }).refine((input) => input.startDate === undefined || input.endDate === undefined || input.startDate < input.endDate, { message: "startDate must be before endDate." }),
    },
    async (input) => withDatabase(config, "aggregate_training", (database) => aggregateTraining(database, input)),
  );

  registerResources(server, config);
  return server;
}

const PRIVACY_POLICY = `# Strava MCP privacy behaviour

This server runs locally and reads a Strava export without modifying it.

## Location
- Exact coordinates are withheld by default. Two tools can return them, and
  each requires \`includeLocation\` to be explicitly true on that request. The
  opt-in is never stored, inferred, or reused as session state.
- \`get_activity_route\` returns a simplified route only with \`includeLocation\`.
- \`get_activity_stream\` returns latitude and longitude only with
  \`includeLocation\`. Naming those fields alone is not sufficient: they are
  dropped from the response and reported as withheld.
- \`get_activity\` never returns coordinates at any detail level.

## Never imported
Profile, login, device-identifier, privacy-zone, preference, connected-app,
contact, block, and flag sources, and \`messaging.json\`, are checksummed for
change detection but never parsed into a queryable table. Media bytes are not
ingested and EXIF is never extracted.

## Bounded output
List results paginate and telemetry is capped per request. Missing metrics are
reported as unavailable rather than as zero.

## Generated data
The local database is created outside the export in a current-user-only
directory. The source export is never written to.`;

function registerResources(server: McpServer, config: ServerConfig): void {
  server.registerResource(
    "schema", "strava://schema",
    { title: "Imported data schema", description: "Field names, types, units, privacy classification, and source column mapping.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await readThroughDatabase(config, "strava://schema", (database) => getDataSchema(database))) }] }),
  );

  server.registerResource(
    "archive-summary", "strava://archive-summary",
    { title: "Archive summary", description: "Current import health, activity coverage, and sport counts.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await readThroughDatabase(config, "strava://archive-summary", (database) => getArchiveSummary(database))) }] }),
  );

  server.registerResource(
    "privacy-policy", "strava://privacy-policy",
    { title: "Privacy policy", description: "Coordinate opt-in rules, redaction defaults, and sources that are never imported.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: PRIVACY_POLICY }] }),
  );
}

/** Resources cannot carry the tool error envelope, so a failure is raised as a
 * sanitized error: the cause goes to stderr, never to the client. */
async function readThroughDatabase<T>(config: ServerConfig, context: string, action: (database: Database) => T): Promise<T> {
  let database: Database;
  try {
    database = await openDatabase(config);
  } catch (error) {
    logInternalError(`${context}: open database`, error);
    throw new Error("The local database could not be opened.");
  }
  try { return action(database); }
  catch (error) {
    logInternalError(context, error);
    throw new Error("The resource could not be read.");
  }
  finally { closeDatabase(database); }
}

/** Supporting import reuses the most recent completed snapshot so validating
 * and importing in sequence records one snapshot rather than two. */
async function latestSnapshotId(exportDir: string, database: Awaited<ReturnType<typeof openDatabase>>): Promise<number> {
  const existing = database.prepare("SELECT id FROM export_snapshots WHERE outcome != 'running' ORDER BY id DESC LIMIT 1").get() as { id: number } | undefined;
  if (existing !== undefined) return existing.id;
  await validateExport(exportDir, database);
  return (database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number }).id;
}

/**
 * Opens the store for one call, runs the tool body, and closes it again. Every
 * failure path resolves to a structured result: an unopenable database is
 * distinguishable from a failure inside the query, and neither reaches the
 * client as a thrown protocol error.
 */
async function withDatabase(config: ServerConfig, context: string, action: (database: Database) => object | Promise<object>): Promise<ToolResult> {
  return guardTool(context, async () => {
    let database: Database;
    try {
      database = await openDatabase(config);
    } catch (error) {
      logInternalError(`${context}: open database`, error);
      return toolFailure("DATABASE_UNAVAILABLE", "The local database could not be opened. Check that STRAVA_MCP_DATA_DIR exists and is writable by this user.");
    }
    try { return toolSuccess(await action(database)); }
    finally { closeDatabase(database); }
  });
}

/** Tools that read the export need it configured before anything is opened. */
async function withExport(config: ServerConfig, context: string, action: (exportDir: string, database: Database) => object | Promise<object>): Promise<ToolResult> {
  const exportDir = config.exportDir;
  if (exportDir === undefined) return toolFailure("EXPORT_DIR_NOT_CONFIGURED", "Set STRAVA_EXPORT_DIR before accessing an export.");
  return withDatabase(config, context, (database) => action(exportDir, database));
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPoint = process.argv[1];
const isMainModule =
  entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;

if (isMainModule) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`Failed to start ${SERVER_NAME}: ${message}`);
    process.exitCode = 1;
  });
}
