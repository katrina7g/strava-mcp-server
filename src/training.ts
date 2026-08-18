import type { Database } from "./database.js";
import { boundedGroups, DEFAULT_MAX_GROUPS } from "./limits.js";
import { offsetCoverage, TIME_COLUMNS, type TimeBasis } from "./localtime.js";

const TIME_BASIS_DEFINITION = "Calendar periods are grouped in local time where an activity's UTC offset is known, and in UTC otherwise. Date-range filters always use the UTC instant.";

export type TrainingFilter = Readonly<{
  sports?: readonly string[] | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
}>;

export type TrainingMetric = "activityCount" | "distanceMeters" | "durationSeconds" | "elevationGainMeters" | "averagePaceSecondsPerKm" | "averageHeartRate" | "averageWatts" | "relativeEffort";

const METRIC_EXPRESSIONS: Record<TrainingMetric, string> = {
  activityCount: "COUNT(*)",
  distanceMeters: "COALESCE(SUM(distance_meters), 0)",
  durationSeconds: "COALESCE(SUM(duration_seconds), 0)",
  elevationGainMeters: "COALESCE(SUM(elevation_gain_meters), 0)",
  averagePaceSecondsPerKm: "CASE WHEN SUM(distance_meters) > 0 THEN SUM(COALESCE(moving_seconds, duration_seconds)) * 1000.0 / SUM(distance_meters) END",
  averageHeartRate: "AVG(average_heart_rate)",
  averageWatts: "AVG(average_watts)",
  relativeEffort: "COALESCE(SUM(relative_effort), 0)",
};

function whereFor(filter: TrainingFilter, prefix = ""): { where: string[]; values: unknown[] } {
  const column = (name: string) => prefix ? `${prefix}.${name}` : name;
  const where = [`${column("observation_status")} = 'observed'`]; const values: unknown[] = [];
  if (filter.sports?.length) { where.push(`${column("sport_type")} IN (${filter.sports.map(() => "?").join(", ")})`); values.push(...filter.sports); }
  if (filter.startDate !== undefined) { where.push(`${column("started_at")} >= ?`); values.push(filter.startDate); }
  if (filter.endDate !== undefined) { where.push(`${column("started_at")} < ?`); values.push(filter.endDate); }
  return { where, values };
}

function metricAvailability(database: Database, filter: TrainingFilter): object {
  const { where, values } = whereFor(filter);
  return database.prepare(`
    SELECT COUNT(*) AS activities,
      SUM(distance_meters IS NOT NULL) AS distance,
      SUM(average_heart_rate IS NOT NULL) AS averageHeartRate,
      SUM(average_watts IS NOT NULL) AS averageWatts,
      SUM(relative_effort IS NOT NULL) AS relativeEffort,
      SUM(training_load IS NOT NULL) AS trainingLoad
    FROM activities WHERE ${where.join(" AND ")}
  `).get(...values) as object;
}

export function listSports(database: Database, filter: TrainingFilter): object {
  const { where, values } = whereFor(filter);
  const sports = database.prepare(`
    SELECT sport_type AS sport, COUNT(*) AS activityCount,
      MIN(started_at) AS firstActivityAt, MAX(started_at) AS lastActivityAt,
      SUM(distance_meters IS NOT NULL) AS activitiesWithDistance,
      SUM(average_heart_rate IS NOT NULL) AS activitiesWithAverageHeartRate,
      SUM(average_watts IS NOT NULL) AS activitiesWithAverageWatts,
      SUM(relative_effort IS NOT NULL) AS activitiesWithRelativeEffort,
      SUM(training_load IS NOT NULL) AS activitiesWithTrainingLoad
    FROM activities WHERE ${where.join(" AND ")}
    GROUP BY sport_type ORDER BY activityCount DESC, sport
  `).all(...values);
  return {
    sports,
    capabilities: {
      generic: ["search", "count", "duration", "distance when present"],
      telemetry: "Routes, streams, and laps are available for activities whose detailed file has been decoded.",
      unavailable: "Pace is an activity-level estimate. Split-based pacing and per-split telemetry are not implemented for any sport.",
    },
  };
}

export function getSportSummary(database: Database, input: TrainingFilter & { sport: string; groupBy?: "week" | "month" | "year" | undefined; timeBasis?: TimeBasis | undefined; maxGroups?: number | undefined }): object {
  const groupBy = input.groupBy ?? "month";
  const timeBasis = input.timeBasis ?? "local";
  const time = TIME_COLUMNS[timeBasis];
  const grouping = { week: `strftime('%Y-%W', ${time})`, month: `strftime('%Y-%m', ${time})`, year: `strftime('%Y', ${time})` } as const;
  const filter: TrainingFilter = { sports: [input.sport], startDate: input.startDate, endDate: input.endDate };
  const { where, values } = whereFor(filter);
  const bounded = boundedGroups(database, `
    SELECT ${grouping[groupBy]} AS period,
      ${METRIC_EXPRESSIONS.activityCount} AS activityCount,
      ${METRIC_EXPRESSIONS.distanceMeters} AS distanceMeters,
      ${METRIC_EXPRESSIONS.durationSeconds} AS durationSeconds,
      ${METRIC_EXPRESSIONS.elevationGainMeters} AS elevationGainMeters,
      ${METRIC_EXPRESSIONS.averagePaceSecondsPerKm} AS averagePaceSecondsPerKm,
      ${METRIC_EXPRESSIONS.averageHeartRate} AS averageHeartRate,
      ${METRIC_EXPRESSIONS.averageWatts} AS averageWatts,
      ${METRIC_EXPRESSIONS.relativeEffort} AS relativeEffort
    FROM activities WHERE ${where.join(" AND ")}
    GROUP BY period ORDER BY period ASC
  `, values, input.maxGroups ?? DEFAULT_MAX_GROUPS);
  return {
    sport: input.sport, groupBy, groups: bounded.groups,
    totalGroups: bounded.totalGroups, truncated: bounded.truncated, maxGroups: bounded.maxGroups,
    timeBasis, offsetCoverage: offsetCoverage(database),
    metricAvailability: metricAvailability(database, filter),
    definitions: { averagePaceSecondsPerKm: "Total moving time (or elapsed time when moving time is absent) divided by total distance; not a split-based pace.", timeBasis: TIME_BASIS_DEFINITION },
  };
}

export function compareTrainingPeriods(database: Database, input: TrainingFilter & { baselineStart: string; baselineEnd: string; comparisonStart: string; comparisonEnd: string; metrics?: readonly TrainingMetric[] | undefined }): object {
  const metrics = input.metrics?.length ? input.metrics : ["activityCount", "distanceMeters", "durationSeconds", "averagePaceSecondsPerKm"] as const;
  const period = (startDate: string, endDate: string) => {
    const { where, values } = whereFor({ sports: input.sports, startDate, endDate });
    const select = metrics.map((metric) => `${METRIC_EXPRESSIONS[metric]} AS ${metric}`).join(", ");
    return database.prepare(`SELECT ${select} FROM activities WHERE ${where.join(" AND ")}`).get(...values) as Record<string, number | null>;
  };
  const baseline = period(input.baselineStart, input.baselineEnd); const comparison = period(input.comparisonStart, input.comparisonEnd);
  const changes = Object.fromEntries(metrics.map((metric) => {
    const before = baseline[metric] ?? null; const after = comparison[metric] ?? null;
    const absolute = before === null || after === null ? null : after - before;
    const percentChange = absolute === null || before === null || before === 0 ? null : (absolute / Math.abs(before)) * 100;
    return [metric, { baseline: before, comparison: after, absoluteChange: absolute, percentChange }];
  }));
  return { baseline: { startDate: input.baselineStart, endDate: input.baselineEnd }, comparison: { startDate: input.comparisonStart, endDate: input.comparisonEnd }, metrics: changes, definitions: { averagePaceSecondsPerKm: "Lower is faster; percent change is not a performance score." } };
}

export function getPersonalBests(database: Database, input: TrainingFilter & { sport: string; metric: "distanceMeters" | "averagePaceSecondsPerKm" | "elevationGainMeters" | "averageWatts"; minDistanceMeters?: number | undefined; maxDistanceMeters?: number | undefined; minDurationSeconds?: number | undefined; limit?: number | undefined }): object {
  const { where, values } = whereFor({ sports: [input.sport], startDate: input.startDate, endDate: input.endDate });
  if (input.minDistanceMeters !== undefined) { where.push("distance_meters >= ?"); values.push(input.minDistanceMeters); }
  if (input.maxDistanceMeters !== undefined) { where.push("distance_meters <= ?"); values.push(input.maxDistanceMeters); }
  if (input.minDurationSeconds !== undefined) { where.push("duration_seconds >= ?"); values.push(input.minDurationSeconds); }
  const expressions = {
    distanceMeters: "distance_meters",
    averagePaceSecondsPerKm: "CASE WHEN distance_meters > 0 THEN COALESCE(moving_seconds, duration_seconds) * 1000.0 / distance_meters END",
    elevationGainMeters: "elevation_gain_meters",
    averageWatts: "average_watts",
  } as const;
  const metricExpression = expressions[input.metric];
  where.push(`${metricExpression} IS NOT NULL`);
  const direction = input.metric === "averagePaceSecondsPerKm" ? "ASC" : "DESC";
  const results = database.prepare(`
    SELECT id, name, started_at AS startedAt, sport_type AS sportType, distance_meters AS distanceMeters,
      duration_seconds AS durationSeconds, moving_seconds AS movingSeconds, elevation_gain_meters AS elevationGainMeters,
      average_watts AS averageWatts, ${metricExpression} AS value
    FROM activities WHERE ${where.join(" AND ")}
    ORDER BY value ${direction}, started_at DESC LIMIT ?
  `).all(...values, input.limit ?? 5);
  const definitions = {
    distanceMeters: "Longest catalog distance.",
    averagePaceSecondsPerKm: "Fastest activity-level pace from moving time (or elapsed time) divided by distance; not a verified event result.",
    elevationGainMeters: "Largest catalog elevation gain.",
    averageWatts: "Highest supplied catalog average watts.",
  } as const;
  return { sport: input.sport, metric: input.metric, results, definition: definitions[input.metric] };
}

export function analyzeActivity(database: Database, activityId: string, analysisType: "catalogSummary" | "pace" | "intensity"): object {
  const activity = database.prepare(`
    SELECT id, name, sport_type AS sportType, started_at AS startedAt, duration_seconds AS durationSeconds,
      moving_seconds AS movingSeconds, distance_meters AS distanceMeters, elevation_gain_meters AS elevationGainMeters,
      average_heart_rate AS averageHeartRate, average_watts AS averageWatts, relative_effort AS relativeEffort,
      training_load AS trainingLoad, intensity
    FROM activities WHERE id = ? AND observation_status = 'observed'
  `).get(activityId) as Record<string, number | string | null> | undefined;
  if (activity === undefined) return { found: false, activityId, message: "No currently observed imported activity matches this ID." };
  const movingSeconds = activity.movingSeconds ?? activity.durationSeconds;
  const pace = typeof activity.distanceMeters === "number" && activity.distanceMeters > 0 && typeof movingSeconds === "number" ? (movingSeconds * 1000) / activity.distanceMeters : null;
  const analysis = analysisType === "pace"
    ? { averagePaceSecondsPerKm: pace, definition: "Activity-level moving-time pace over the whole activity. Split-based pacing is not implemented; use get_activity_stream for raw telemetry." }
    : analysisType === "intensity"
      ? { relativeEffort: activity.relativeEffort, trainingLoad: activity.trainingLoad, intensity: activity.intensity, averageHeartRate: activity.averageHeartRate, averageWatts: activity.averageWatts, definition: "Values are source-supplied catalog fields. Telemetry progression and anomaly detection are not implemented." }
      : { durationSeconds: activity.durationSeconds, distanceMeters: activity.distanceMeters, elevationGainMeters: activity.elevationGainMeters, averagePaceSecondsPerKm: pace };
  return {
    found: true, activity: { id: activity.id, name: activity.name, sportType: activity.sportType, startedAt: activity.startedAt }, analysisType, analysis,
    limitations: [
      "Catalog-only analysis: values come from the activity catalog, not from decoded telemetry.",
      "Splits, pauses, and telemetry progression are not implemented. Decoded streams are reachable through get_activity_stream and get_activity_route.",
    ],
  };
}

export function getTrainingLoad(database: Database, input: TrainingFilter & { groupBy?: "week" | "month" | "sport" | undefined; preference?: "supplied" | "relativeEffort" | "duration" | undefined; timeBasis?: TimeBasis | undefined; maxGroups?: number | undefined }): object {
  const groupBy = input.groupBy ?? "week"; const preference = input.preference ?? "supplied";
  const timeBasis = input.timeBasis ?? "local";
  const time = TIME_COLUMNS[timeBasis];
  const grouping = { week: `strftime('%Y-%W', ${time})`, month: `strftime('%Y-%m', ${time})`, sport: "COALESCE(sport_type, 'Unknown')" } as const;
  const { where, values } = whereFor(input);
  const expression = preference === "supplied"
    ? "training_load"
    : preference === "relativeEffort" ? "relative_effort" : "duration_seconds / 3600.0";
  const source = preference === "supplied" ? "supplied catalog Training Load" : preference === "relativeEffort" ? "supplied catalog Relative Effort" : "derived duration hours";
  const bounded = boundedGroups(database, `
    SELECT ${grouping[groupBy]} AS period, COUNT(*) AS activityCount,
      SUM(${expression} IS NOT NULL) AS activitiesWithPreferredMetric,
      CASE WHEN COUNT(${expression}) = 0 THEN NULL ELSE SUM(${expression}) END AS trainingLoad
    FROM activities WHERE ${where.join(" AND ")}
    GROUP BY period ORDER BY period ASC
  `, values, input.maxGroups ?? DEFAULT_MAX_GROUPS);
  return {
    groupBy, preference, source, groups: bounded.groups,
    totalGroups: bounded.totalGroups, truncated: bounded.truncated, maxGroups: bounded.maxGroups,
    timeBasis: groupBy === "sport" ? "not-applicable" : timeBasis,
    offsetCoverage: offsetCoverage(database),
    definition: preference === "duration" ? "Derived as total activity duration in hours; it is a volume proxy, not physiological training load." : "Sum of the selected source-supplied metric; values are not comparable to a standardized training-load model.",
    definitions: { timeBasis: TIME_BASIS_DEFINITION },
  };
}
