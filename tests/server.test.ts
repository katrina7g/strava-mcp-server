import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("creates an unconnected local read-only server", () => {
    const server = createServer(
      loadConfig({ STRAVA_MCP_DATA_DIR: "/tmp/strava-mcp-server-test-cache" }),
    );

    expect(server.isConnected()).toBe(false);
  });
});

const temporaryRoots: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-server-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function textContent(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]!.text;
}

/** Resource contents are text or binary; these resources are always text. */
function resourceText(result: { contents: unknown[] }): string {
  const first = result.contents[0] as { text?: unknown } | undefined;
  if (first === undefined || typeof first.text !== "string") throw new Error("Expected a text resource.");
  return first.text;
}

async function connectedClient(config: ServerConfig): Promise<{ server: McpServer; client: Client }> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("MCP server tool surface", () => {
  it("serves get_server_info over a real MCP transport", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "get_server_info", arguments: {} });
    const payload = JSON.parse(textContent(result));
    expect(payload).toMatchObject({ name: "strava-mcp-server", mode: "local-read-only", exportConfigured: false });
    await client.close();
  });

  it("runs validate_export over a real MCP transport and returns a structured report", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Filename\n1,activities/run.gpx\n");
    await writeFile(join(exportDir, "activities", "run.gpx"), "<gpx />");
    const config = loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textContent(result));
    expect(payload.outcome).toBe("completed");
    expect(payload.delta).toEqual({ new: 2, changed: 0, unchanged: 0, noLongerObserved: 0 });
    await client.close();
  });

  it("returns a functional error over MCP when no export is configured", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(textContent(result));
    expect(payload.code).toBe("EXPORT_DIR_NOT_CONFIGURED");
    await client.close();
  });

  it("bounds MCP findings while preserving the total count", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(exportDir, { recursive: true });
    const rows = Array.from({ length: 60 }, (_, index) => `${index},activities/missing-${index}.gpx`).join("\n");
    await writeFile(join(exportDir, "activities.csv"), `Activity ID,Filename\n${rows}\n`);
    const config = loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    const payload = JSON.parse(textContent(result));
    expect(payload.findings).toHaveLength(50);
    expect(payload.totalFindings).toBe(60);
    expect(payload.findingsTruncated).toBe(true);
    await client.close();
  });

  it("imports a catalog and serves archive, schema, search, and aggregate tools", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n1,Jan 1 2026 10:00:00 AM,Morning Run,Run,3600,6.2,activities/1.gpx,3500,10000,120\n2,Feb 1 2026 10:00:00 AM,Bike Ride,Ride,7200,12.4,activities/2.fit,7000,20000,300\n");
    await writeFile(join(exportDir, "activities", "1.gpx"), "<gpx />"); await writeFile(join(exportDir, "activities", "2.fit"), "fit");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_activity_catalog", arguments: {} })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_archive_summary", arguments: {} })));
    const schema = JSON.parse(textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "activities" } })));
    const searched = JSON.parse(textContent(await client.callTool({ name: "search_activities", arguments: { sports: ["Run"], text: "Morning" } })));
    const aggregated = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "sport", metrics: ["activityCount", "distanceMeters"] } })));
    expect(imported.catalogDelta).toMatchObject({ inserted: 2 });
    expect(summary.overview.activityCount).toBe(2);
    expect(schema.activities.fields.some((field: { name: string }) => field.name === "distanceMeters")).toBe(true);
    expect(searched.activities).toHaveLength(1);
    expect(aggregated.groups).toEqual(expect.arrayContaining([expect.objectContaining({ period: "Run", activityCount: 1, distanceMeters: 10000 })]));
    await client.close();
  });

  it("paginates safely and represents unavailable metrics as null", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, index) => `${index + 1},Jan ${index + 1} 2026 10:00:00 AM,Run ${index + 1},Run,1800,3,activities/${index + 1}.gpx,1700,4828,10`).join("\n");
    await writeFile(join(exportDir, "activities.csv"), `Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n${rows}\n`);
    for (const index of [1, 2, 3]) await writeFile(join(exportDir, "activities", `${index}.gpx`), "<gpx />");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const firstPage = JSON.parse(textContent(await client.callTool({ name: "search_activities", arguments: { page: 1, pageSize: 2, sortDirection: "asc" } })));
    const aggregate = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "sport", metrics: ["averageWatts", "averageHeartRate"] } })));
    expect(firstPage.activities).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, hasMore: true });
    expect(aggregate.groups).toEqual([{ period: "Run", averageWatts: null, averageHeartRate: null }]);
    await client.close();
  });

  it("serves catalog-based training analysis with explicit metric limitations", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain,Average Heart Rate,Average Watts,Relative Effort,Training Load,Intensity,Commute\nrun-1,Jan 5 2026 10:00:00 AM,Steady Run,Run,3600,6.2,activities/run-1.gpx,3500,10000,100,150,210,30,40,55,false\nrun-2,Feb 5 2026 10:00:00 AM,Fast Run,Run,3000,6.2,activities/run-2.gpx,2900,11000,100,160,230,45,55,70,false\nride-1,Feb 6 2026 10:00:00 AM,Ride,Ride,7200,12.4,activities/ride-1.fit,7000,20000,300,140,190,60,70,65,false\n");
    for (const file of ["run-1.gpx", "run-2.gpx", "ride-1.fit"]) await writeFile(join(exportDir, "activities", file), "synthetic");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const sports = JSON.parse(textContent(await client.callTool({ name: "list_sports", arguments: {} })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_sport_summary", arguments: { sport: "Run", groupBy: "month" } })));
    const comparison = JSON.parse(textContent(await client.callTool({ name: "compare_training_periods", arguments: { sports: ["Run"], baselineStart: "2026-01-01T00:00:00Z", baselineEnd: "2026-02-01T00:00:00Z", comparisonStart: "2026-02-01T00:00:00Z", comparisonEnd: "2026-03-01T00:00:00Z", metrics: ["distanceMeters", "averagePaceSecondsPerKm"] } })));
    const bests = JSON.parse(textContent(await client.callTool({ name: "get_personal_bests", arguments: { sport: "Run", metric: "averagePaceSecondsPerKm" } })));
    const activity = JSON.parse(textContent(await client.callTool({ name: "analyze_activity", arguments: { activityId: "run-1", analysisType: "pace" } })));
    const load = JSON.parse(textContent(await client.callTool({ name: "get_training_load", arguments: { sports: ["Run"], groupBy: "month", preference: "supplied" } })));
    expect(sports.sports).toEqual(expect.arrayContaining([expect.objectContaining({ sport: "Run", activityCount: 2, activitiesWithTrainingLoad: 2 })]));
    expect(summary.groups).toHaveLength(2);
    expect(comparison.metrics.distanceMeters).toMatchObject({ baseline: 10000, comparison: 11000 });
    expect(bests.results[0]).toMatchObject({ id: "run-2" });
    expect(activity.analysis.averagePaceSecondsPerKm).toBe(350);
    expect(activity.limitations[0]).toContain("Catalog-only analysis");
    // Splits are unimplemented, not merely pending a detailed-format import.
    expect(activity.limitations.join(" ")).toContain("not implemented");
    expect(activity.limitations.join(" ")).not.toContain("until detailed");
    expect(sports.capabilities.unavailable).toContain("not implemented");
    expect(load).toMatchObject({ source: "supplied catalog Training Load", groups: [expect.objectContaining({ trainingLoad: 40 }), expect.objectContaining({ trainingLoad: 55 })] });
    await client.close();
  });

  it("imports a detailed GPX file and keeps route coordinates opt-in", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\ngpx-1,Jan 1 2026 10:00:00 AM,GPX Run,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n");
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), "<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"37.1\" lon=\"-122.1\"><ele>10</ele><time>2026-01-01T18:00:00Z</time><extensions><gpxtpx:hr xmlns:gpxtpx=\"x\">140</gpxtpx:hr></extensions></trkpt><trkpt lat=\"37.2\" lon=\"-122.2\"><ele>15</ele><time>2026-01-01T18:01:00Z</time></trkpt></trkseg></trk></gpx>");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_detailed_activities", arguments: { activityId: "gpx-1" } })));
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1", fields: ["timestamp", "altitudeMeters", "heartRate"] } })));
    const privateRoute = JSON.parse(textContent(await client.callTool({ name: "get_activity_route", arguments: { activityId: "gpx-1" } })));
    const route = JSON.parse(textContent(await client.callTool({ name: "get_activity_route", arguments: { activityId: "gpx-1", includeLocation: true } })));
    expect(imported).toMatchObject({ decoded: 1, failed: 0 });
    expect(stream.points).toHaveLength(2);
    expect(stream.points[0]).toMatchObject({ altitudeMeters: 10, heartRate: 140 });
    expect(privateRoute).toMatchObject({ includeLocation: false });
    expect(JSON.stringify(privateRoute)).not.toContain("-122.1");
    expect(route.geometry).toMatchObject({ type: "LineString", coordinates: [[-122.1, 37.1], [-122.2, 37.2]] });
    await client.close();
  });

  it("serves get_activity with decode status, lap count, and no coordinates", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\ngpx-1,Jan 1 2026 10:00:00 AM,GPX Run,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n");
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), "<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"37.1\" lon=\"-122.1\"><ele>10</ele><time>2026-01-01T18:00:00Z</time></trkpt><trkpt lat=\"37.2\" lon=\"-122.2\"><ele>15</ele><time>2026-01-01T18:01:00Z</time></trkpt></trkseg></trk></gpx>");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const activity = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "gpx-1" } })));
    const missing = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "absent" } })));

    expect(activity).toMatchObject({ found: true, activity: { id: "gpx-1", sportType: "Run" } });
    expect(activity.files[0]).toMatchObject({ format: "gpx", decodeStatus: "decoded" });
    expect(activity.telemetry).toMatchObject({ imported: true, pointCount: 2, lapCount: 0, hasLocation: true });
    // GPX supplies no per-point distance, so the catalog total is used and labelled.
    expect(activity.derived).toMatchObject({ totalDistanceMeters: 100, totalDistanceSource: "catalog" });
    expect(JSON.stringify(activity)).not.toContain("-122.1");
    expect(missing).toMatchObject({ found: false });
    await client.close();
  });

  it("reports per-field stream availability so absent metrics are not read as zero", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\ngpx-1,Jan 1 2026 10:00:00 AM,GPX Run,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n");
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), "<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"37.1\" lon=\"-122.1\"><ele>10</ele><time>2026-01-01T18:00:00Z</time><extensions><gpxtpx:hr xmlns:gpxtpx=\"x\">140</gpxtpx:hr></extensions></trkpt><trkpt lat=\"37.2\" lon=\"-122.2\"><ele>15</ele><time>2026-01-01T18:01:00Z</time></trkpt></trkseg></trk></gpx>");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1", fields: ["heartRate", "distanceMeters"] } })));

    // One of two points has heart rate; GPX never supplies distance.
    expect(stream.fieldAvailability).toEqual({ heartRate: 1, distanceMeters: 0 });
    await client.close();
  });

  it("withholds stream coordinates unless includeLocation is set on the request", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\ngpx-1,Jan 1 2026 10:00:00 AM,GPX Run,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n");
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), "<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"37.1\" lon=\"-122.1\"><ele>10</ele><time>2026-01-01T18:00:00Z</time></trkpt></trkseg></trk></gpx>");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });

    const fields = ["timestamp", "latitude", "longitude"];
    const withheld = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1", fields } })));
    const granted = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1", fields, includeLocation: true } })));
    const defaulted = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1" } })));

    // Naming the coordinate fields is not consent; they are dropped and reported.
    expect(withheld.fields).toEqual(["timestamp"]);
    expect(withheld.withheldFields).toEqual(["latitude", "longitude"]);
    expect(JSON.stringify(withheld)).not.toContain("37.1");
    expect(JSON.stringify(withheld)).not.toContain("-122.1");
    // The opt-in is per request and never carried over.
    expect(granted.points[0]).toMatchObject({ latitude: 37.1, longitude: -122.1 });
    expect(JSON.stringify(defaulted)).not.toContain("37.1");
    await client.close();
  });

  it("caps grouped results and discloses the truncation", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    // Twelve activities on distinct days, so day grouping yields twelve groups.
    const rows = Array.from({ length: 12 }, (_, index) => `${index + 1},Jan ${index + 1} 2026 10:00:00 AM,Run ${index + 1},Run,1800,3,activities/${index + 1}.gpx,1700,4828,10`).join("\n");
    await writeFile(join(exportDir, "activities.csv"), `Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n${rows}\n`);
    for (let index = 1; index <= 12; index += 1) await writeFile(join(exportDir, "activities", `${index}.gpx`), "<gpx />");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });

    const capped = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "day", metrics: ["activityCount"], maxGroups: 5 } })));
    const whole = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "day", metrics: ["activityCount"] } })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_sport_summary", arguments: { sport: "Run", groupBy: "week", maxGroups: 1 } })));
    const load = JSON.parse(textContent(await client.callTool({ name: "get_training_load", arguments: { groupBy: "week", maxGroups: 1 } })));

    // The cap limits the rows returned but never hides how many exist.
    expect(capped.groups).toHaveLength(5);
    expect(capped).toMatchObject({ totalGroups: 12, truncated: true, maxGroups: 5 });
    expect(whole.groups).toHaveLength(12);
    expect(whole).toMatchObject({ totalGroups: 12, truncated: false });
    expect(summary).toMatchObject({ truncated: true });
    expect(load).toMatchObject({ truncated: true });
    await client.close();
  });

  it("rejects a group cap above the hard maximum", async () => {
    const root = await temporaryDirectory();
    const { client } = await connectedClient(loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    // Input validation is enforced by the schema, upstream of the tool body,
    // so it surfaces as an error result rather than a structured tool failure.
    const result = await client.callTool({ name: "aggregate_training", arguments: { groupBy: "day", maxGroups: 5000 } });

    expect(result.isError).toBe(true);
    expect(textContent(result)).toContain("maxGroups");
    await client.close();
  });

  it("returns a structured error instead of leaking internals when a tool fails", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    // An export directory that does not exist: the validator must not surface
    // the filesystem path or the underlying ENOENT text.
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    const result = await client.callTool({ name: "validate_export", arguments: {} });
    const payload = JSON.parse(textContent(result));

    expect(payload.outcome).toBe("completed-with-errors");
    expect(payload.findings[0]).toMatchObject({ code: "EXPORT_ROOT_INVALID" });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain(exportDir);
    expect(serialized).not.toContain("ENOENT");
    await client.close();
  });

  it("reports a database that cannot be opened with a stable code", async () => {
    const root = await temporaryDirectory();
    // A data directory path that cannot be created, because a file occupies it.
    const blocked = join(root, "blocked");
    await writeFile(blocked, "not a directory");
    const { client } = await connectedClient(loadConfig({ STRAVA_MCP_DATA_DIR: join(blocked, "cache") }));
    const result = await client.callTool({ name: "get_archive_summary", arguments: {} });
    const payload = JSON.parse(textContent(result));

    expect(result.isError).toBe(true);
    expect(payload.code).toBe("DATABASE_UNAVAILABLE");
    expect(JSON.stringify(payload)).not.toContain("ENOTDIR");
    await client.close();
  });

  it("serves the schema, archive-summary, and privacy-policy resources", async () => {
    const root = await temporaryDirectory();
    const { client } = await connectedClient(loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    const listed = await client.listResources();
    const schema = await client.readResource({ uri: "strava://schema" });
    const summary = await client.readResource({ uri: "strava://archive-summary" });
    const privacy = await client.readResource({ uri: "strava://privacy-policy" });

    expect(listed.resources.map((resource) => resource.uri).sort()).toEqual(["strava://archive-summary", "strava://privacy-policy", "strava://schema"]);
    expect(JSON.parse(resourceText(schema))).toHaveProperty("activities");
    expect(JSON.parse(resourceText(summary))).toHaveProperty("overview");
    expect(resourceText(privacy)).toContain("includeLocation");
    await client.close();
  });

  it("imports whitespace-prefixed compressed TCX with laps", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\ntcx-1,Jan 1 2026 10:00:00 AM,TCX Run,Run,120,0.1,activities/tcx-1.tcx.gz,110,100,5\n");
    const tcx = " \n<?xml version=\"1.0\"?><TrainingCenterDatabase><Activities><Activity><Lap StartTime=\"2026-01-01T18:00:00Z\"><TotalTimeSeconds>60</TotalTimeSeconds><DistanceMeters>100</DistanceMeters><Track><Trackpoint><Time>2026-01-01T18:00:00Z</Time><Position><LatitudeDegrees>37.1</LatitudeDegrees><LongitudeDegrees>-122.1</LongitudeDegrees></Position><AltitudeMeters>10</AltitudeMeters><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>130</Value></HeartRateBpm><Cadence>80</Cadence></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>";
    await writeFile(join(exportDir, "activities", "tcx-1.tcx.gz"), gzipSync(tcx));
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_detailed_activities", arguments: { activityId: "tcx-1" } })));
    expect(imported.results[0]).toMatchObject({ status: "decoded", pointCount: 1, lapCount: 1 });
    await client.close();
  });
});
