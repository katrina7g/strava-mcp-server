import type { Database } from "./database.js";

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
  return { overview, sports, latestSnapshot: snapshot ?? null, sources };
}

export function getDataSchema(database: Database, domain?: string): object {
  const latestMap = database.prepare("SELECT map_version AS mapVersion, columns_json AS columns FROM catalog_column_maps WHERE source_path = 'activities.csv' ORDER BY snapshot_id DESC LIMIT 1").get() as { mapVersion: number; columns: string } | undefined;
  const fields = domain === undefined || domain === "activities" || domain === "catalog" ? ACTIVITY_FIELDS : [];
  return {
    domain: domain ?? "all",
    activities: { fields, rawCatalogRows: "activity_catalog_rows", currentState: "activities" },
    sourceColumnMap: latestMap === undefined ? null : { mapVersion: latestMap.mapVersion, columns: JSON.parse(latestMap.columns) },
    note: "Exact coordinates, direct identifiers, and raw source values are not exposed by activity query tools.",
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
  const grouping = {
    day: "strftime('%Y-%m-%d', started_at)",
    week: "strftime('%Y-%W', started_at)",
    month: "strftime('%Y-%m', started_at)",
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
  return { groupBy, metrics: requested, groups };
}
