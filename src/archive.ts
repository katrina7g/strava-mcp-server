import type { Database } from "./database.js";
import { resolveTotalDistance } from "./details.js";
import { offsetCoverage, TIME_COLUMNS, type TimeBasis } from "./localtime.js";

export type ActivitySearchInput = Readonly<{
  sports?: readonly string[] | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  minDistanceMeters?: number | undefined;
  maxDistanceMeters?: number | undefined;
  minDurationSeconds?: number | undefined;
  maxDurationSeconds?: number | undefined;
  minRelativeEffort?: number | undefined;
  text?: string | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: "startedAt" | "distanceMeters" | "durationSeconds" | undefined;
  sortDirection?: "asc" | "desc" | undefined;
}>;

export type AggregateInput = Readonly<{
  sports?: readonly string[] | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  groupBy?: "day" | "week" | "month" | "sport" | undefined;
  metrics?: readonly ("activityCount" | "distanceMeters" | "durationSeconds" | "elevationGainMeters" | "averageHeartRate" | "averageWatts" | "relativeEffort")[] | undefined;
  timeBasis?: TimeBasis | undefined;
}>;

const ACTIVITY_FIELDS = [
  { name: "id", type: "string", unit: null, privacy: "private" },
  { name: "name", type: "string", unit: null, privacy: "private" },
  { name: "sportType", type: "string", unit: null, privacy: "private" },
  { name: "startedAt", type: "datetime", unit: "ISO-8601", privacy: "private" },
  { name: "durationSeconds", type: "number", unit: "seconds", privacy: "private" },
  { name: "movingSeconds", type: "number", unit: "seconds", privacy: "private" },
  { name: "distanceMeters", type: "number", unit: "meters", privacy: "private" },
  { name: "elevationGainMeters", type: "number", unit: "meters", privacy: "private" },
  { name: "averageHeartRate", type: "number", unit: "bpm", privacy: "private" },
  { name: "averageWatts", type: "number", unit: "watts", privacy: "private" },
  { name: "relativeEffort", type: "number", unit: null, privacy: "private" },
  { name: "trainingLoad", type: "number", unit: "source-defined", privacy: "private" },
  { name: "intensity", type: "number", unit: "source-defined", privacy: "private" },
  { name: "commute", type: "boolean", unit: null, privacy: "private" },
] as const;

const GEAR_FIELDS = [
  { name: "name", type: "string", unit: null, privacy: "private" },
  { name: "gearType", type: "string", unit: null, privacy: "private" },
  { name: "brand", type: "string", unit: null, privacy: "private" },
  { name: "model", type: "string", unit: null, privacy: "private" },
  { name: "activityCount", type: "number", unit: "activities", privacy: "private" },
  { name: "distanceMeters", type: "number", unit: "meters", privacy: "private" },
  { name: "source", type: "string", unit: null, privacy: "private" },
] as const;

/**
 * Sources present in an export that this server deliberately does not parse
 * into a queryable table. Naming them keeps a client from inferring that a
 * domain is absent from the export when it is merely not imported.
 */
const NOT_IMPORTED_DOMAINS = [
  { domain: "media", reason: "No query tool is implemented yet; references are validated but not imported." },
  { domain: "challenges", reason: "No query tool is implemented yet." },
  { domain: "clubs", reason: "No query tool is implemented yet." },
  { domain: "social", reason: "No query tool is implemented yet. Reactions in an export are those the account gave, never those its activities received." },
  { domain: "profile-and-account", reason: "Profile, login, device, privacy-zone, preference, connected-app, contact, block, and flag sources are checksummed for change detection and never parsed." },
  { domain: "messaging", reason: "messaging.json is checksummed and never parsed." },
] as const;

function filters(input: Pick<ActivitySearchInput, "sports" | "startDate" | "endDate" | "minDistanceMeters" | "maxDistanceMeters" | "minDurationSeconds" | "maxDurationSeconds" | "minRelativeEffort" | "text">): { where: string[]; values: unknown[] } {
  const where = ["observation_status = 'observed'"]; const values: unknown[] = [];
  if (input.sports?.length) { where.push(`sport_type IN (${input.sports.map(() => "?").join(", ")})`); values.push(...input.sports); }
  if (input.startDate !== undefined) { where.push("started_at >= ?"); values.push(input.startDate); }
  if (input.endDate !== undefined) { where.push("started_at < ?"); values.push(input.endDate); }
  if (input.minDistanceMeters !== undefined) { where.push("distance_meters >= ?"); values.push(input.minDistanceMeters); }
  if (input.maxDistanceMeters !== undefined) { where.push("distance_meters <= ?"); values.push(input.maxDistanceMeters); }
  if (input.minDurationSeconds !== undefined) { where.push("duration_seconds >= ?"); values.push(input.minDurationSeconds); }
  if (input.maxDurationSeconds !== undefined) { where.push("duration_seconds <= ?"); values.push(input.maxDurationSeconds); }
  if (input.minRelativeEffort !== undefined) { where.push("relative_effort >= ?"); values.push(input.minRelativeEffort); }
  if (input.text !== undefined) { where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')"); const escaped = `%${input.text.replace(/[\\%_]/g, "\\$&")}%`; values.push(escaped, escaped); }
  return { where, values };
}

export function getArchiveSummary(database: Database): object {
  const overview = database.prepare(`
    SELECT COUNT(*) AS activityCount, MIN(started_at) AS firstActivityAt,
      MAX(started_at) AS lastActivityAt, COALESCE(SUM(distance_meters), 0) AS distanceMeters,
      COALESCE(SUM(duration_seconds), 0) AS durationSeconds
    FROM activities WHERE observation_status = 'observed'
  `).get();
  const sports = database.prepare(`
    SELECT sport_type AS sport, COUNT(*) AS activityCount,
      SUM(average_heart_rate IS NOT NULL) AS activitiesWithAverageHeartRate,
      SUM(average_watts IS NOT NULL) AS activitiesWithAverageWatts,
      SUM(relative_effort IS NOT NULL) AS activitiesWithRelativeEffort
    FROM activities WHERE observation_status = 'observed'
    GROUP BY sport_type ORDER BY activityCount DESC, sport
  `).all();
  const snapshot = database.prepare("SELECT id, completed_at AS completedAt, outcome FROM export_snapshots ORDER BY id DESC LIMIT 1").get();
  const sources = database.prepare("SELECT source_kind AS sourceKind, COUNT(*) AS files, SUM(CASE WHEN error_summary IS NOT NULL THEN 1 ELSE 0 END) AS errors FROM source_manifest WHERE snapshot_id = (SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1) GROUP BY source_kind ORDER BY source_kind").all();
  // A valid export may simply contain no bikes or clubs. Naming those sources
  // keeps "present but empty" distinguishable from a missing file or a parse
  // failure, which the same manifest also records.
  const emptySources = database.prepare(`
    SELECT relative_path AS source FROM source_manifest
    WHERE snapshot_id = (SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1)
      AND is_empty = 1 AND relative_path LIKE '%.csv' ORDER BY relative_path
  `).all() as { source: string }[];
  const gear = database.prepare("SELECT COUNT(*) AS imported FROM gear WHERE observation_status = 'observed'").get() as { imported: number };
  return {
    overview, sports, latestSnapshot: snapshot ?? null, sources,
    domains: {
      imported: [
        { domain: "activities", records: (overview as { activityCount: number }).activityCount },
        { domain: "gear", records: gear.imported },
      ],
      availableButEmpty: emptySources.map((entry) => entry.source),
      notImported: NOT_IMPORTED_DOMAINS,
    },
  };
}

/**
 * The core single-activity view. Laps are imported for every FIT and TCX
 * activity but no other tool reads them, so this is where they surface.
 * Coordinates are never returned at any detail level; `get_activity_route`
 * remains the only path to them and requires its own opt-in.
 */
export function getActivity(database: Database, activityId: string): object {
  const activity = database.prepare(`
    SELECT id, name, description, sport_type AS sportType, started_at AS startedAt,
      started_at_local AS startedAtLocal, utc_offset_minutes AS utcOffsetMinutes, offset_source AS offsetSource,
      duration_seconds AS durationSeconds, moving_seconds AS movingSeconds, distance_meters AS distanceMeters,
      elevation_gain_meters AS elevationGainMeters, average_heart_rate AS averageHeartRate,
      average_watts AS averageWatts, relative_effort AS relativeEffort, training_load AS trainingLoad,
      intensity, commute, observation_status AS observationStatus
    FROM activities WHERE id = ?
  `).get(activityId) as Record<string, string | number | null> | undefined;
  if (activity === undefined) return { found: false, activityId, message: "No imported activity matches this ID." };

  const files = database.prepare("SELECT relative_path AS relativePath, format, decode_status AS decodeStatus, parse_error AS parseError FROM activity_files WHERE activity_id = ? ORDER BY relative_path").all(activityId);
  const bounds = database.prepare("SELECT point_count AS pointCount, started_at AS startedAt, ended_at AS endedAt, total_distance_meters AS streamDistanceMeters, elevation_gain_meters AS elevationGainMeters, has_location AS hasLocation FROM activity_bounds WHERE activity_id = ?").get(activityId) as { pointCount: number; startedAt: string | null; endedAt: string | null; streamDistanceMeters: number | null; elevationGainMeters: number | null; hasLocation: number } | undefined;
  const laps = database.prepare("SELECT COUNT(*) AS count FROM activity_laps WHERE activity_id = ?").get(activityId) as { count: number };
  const distance = resolveTotalDistance(bounds?.streamDistanceMeters ?? null, typeof activity.distanceMeters === "number" ? activity.distanceMeters : null);
  const movingSeconds = activity.movingSeconds ?? activity.durationSeconds;
  const pace = typeof distance.meters === "number" && distance.meters > 0 && typeof movingSeconds === "number" ? (movingSeconds * 1000) / distance.meters : null;

  return {
    found: true,
    activity,
    derived: {
      totalDistanceMeters: distance.meters,
      totalDistanceSource: distance.source,
      averagePaceSecondsPerKm: pace,
    },
    files,
    telemetry: bounds === undefined
      ? { imported: false, message: "No detailed activity file has been decoded for this activity." }
      : {
        imported: true, pointCount: bounds.pointCount, lapCount: laps.count,
        firstPointAt: bounds.startedAt, lastPointAt: bounds.endedAt,
        elevationGainMeters: bounds.elevationGainMeters, hasLocation: bounds.hasLocation === 1,
      },
    limitations: [
      "Coordinates are never returned by this tool; use get_activity_route with includeLocation.",
      "Split counts and split-based pacing require detailed analysis, which is not implemented.",
    ],
  };
}

export function getDataSchema(database: Database, domain?: string): object {
  const latestMap = database.prepare("SELECT map_version AS mapVersion, columns_json AS columns FROM catalog_column_maps WHERE source_path = 'activities.csv' ORDER BY snapshot_id DESC LIMIT 1").get() as { mapVersion: number; columns: string } | undefined;
  const fields = domain === undefined || domain === "activities" || domain === "catalog" ? ACTIVITY_FIELDS : [];
  return {
    domain: domain ?? "all",
    activities: { fields, rawCatalogRows: "activity_catalog_rows", currentState: "activities" },
    ...(domain === undefined || domain === "gear" ? { gear: { fields: GEAR_FIELDS, currentState: "gear", queryTool: "get_gear" } } : {}),
    notImported: NOT_IMPORTED_DOMAINS,
    sourceColumnMap: latestMap === undefined ? null : { mapVersion: latestMap.mapVersion, columns: JSON.parse(latestMap.columns) },
    note: "Direct identifiers and raw source values are not exposed by activity query tools. Exact coordinates are withheld unless a request to get_activity_route or get_activity_stream sets includeLocation to true.",
  };
}

export function searchActivities(database: Database, input: ActivitySearchInput): object {
  const { where, values } = filters(input);
  const sortExpressions = { startedAt: "started_at", distanceMeters: "distance_meters", durationSeconds: "duration_seconds" } as const;
  const sortBy = input.sortBy ?? "startedAt"; const direction = input.sortDirection === "asc" ? "ASC" : "DESC";
  const page = input.page ?? 1; const pageSize = input.pageSize ?? 25;
  const select = "id, name, sport_type AS sportType, started_at AS startedAt, duration_seconds AS durationSeconds, moving_seconds AS movingSeconds, distance_meters AS distanceMeters, elevation_gain_meters AS elevationGainMeters, average_heart_rate AS averageHeartRate, average_watts AS averageWatts, relative_effort AS relativeEffort, commute";
  const clause = where.join(" AND ");
  const total = database.prepare(`SELECT COUNT(*) AS count FROM activities WHERE ${clause}`).get(...values) as { count: number };
  const activities = database.prepare(`SELECT ${select} FROM activities WHERE ${clause} ORDER BY ${sortExpressions[sortBy]} ${direction}, id ASC LIMIT ? OFFSET ?`).all(...values, pageSize, (page - 1) * pageSize);
  return { activities, pagination: { page, pageSize, total: total.count, hasMore: page * pageSize < total.count } };
}

export function aggregateTraining(database: Database, input: AggregateInput): object {
  const { where, values } = filters(input);
  const timeBasis = input.timeBasis ?? "local";
  const time = TIME_COLUMNS[timeBasis];
  const grouping = {
    day: `strftime('%Y-%m-%d', ${time})`,
    week: `strftime('%Y-%W', ${time})`,
    month: `strftime('%Y-%m', ${time})`,
    sport: "COALESCE(sport_type, 'Unknown')",
  } as const;
  const metricExpressions = {
    activityCount: "COUNT(*)",
    distanceMeters: "COALESCE(SUM(distance_meters), 0)",
    durationSeconds: "COALESCE(SUM(duration_seconds), 0)",
    elevationGainMeters: "COALESCE(SUM(elevation_gain_meters), 0)",
    averageHeartRate: "AVG(average_heart_rate)",
    averageWatts: "AVG(average_watts)",
    relativeEffort: "COALESCE(SUM(relative_effort), 0)",
  } as const;
  const groupBy = input.groupBy ?? "month";
  const requested = input.metrics?.length ? input.metrics : ["activityCount", "distanceMeters", "durationSeconds"] as const;
  const select = requested.map((metric) => `${metricExpressions[metric]} AS ${metric}`).join(", ");
  const groups = database.prepare(`SELECT ${grouping[groupBy]} AS period, ${select} FROM activities WHERE ${where.join(" AND ")} GROUP BY period ORDER BY period ASC`).all(...values);
  return {
    groupBy, metrics: requested, groups,
    timeBasis: groupBy === "sport" ? "not-applicable" : timeBasis,
    offsetCoverage: offsetCoverage(database),
    definitions: { timeBasis: "Calendar periods are grouped in local time where an activity's UTC offset is known, and in UTC otherwise. Date-range filters always use the UTC instant." },
  };
}
