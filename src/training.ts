import type { Database } from "./database.js";
import { boundedGroups, DEFAULT_MAX_GROUPS } from "./limits.js";
import { INTERVAL_METERS } from "./splits.js";
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
      unavailable: "Pace here is an activity-level estimate. Per-split pacing and telemetry come from analyze_activity for activities whose distance source supports interval boundaries.",
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

export type AnalysisType = "catalogSummary" | "pace" | "intensity" | "splits" | "progression" | "pauses";

type StoredSplit = {
  sequence: number; startDistanceMeters: number; endDistanceMeters: number; distanceMeters: number;
  complete: number; startedAt: string | null; endedAt: string | null;
  elapsedSeconds: number | null; movingSeconds: number | null; pausedSeconds: number;
  pauseCount: number; recordingGapCount: number; paceSecondsPerKm: number | null;
  averageHeartRate: number | null; maxHeartRate: number | null; averageCadence: number | null;
  averagePowerWatts: number | null; elevationGainMeters: number | null; elevationLossMeters: number | null;
  pointCount: number; metricsAvailableJson: string; distanceSource: string; derivationVersion: number;
};

/** Split-based analysis is bounded: a long ride yields hundreds of intervals,
 * and an unbounded series is not a usable MCP response. */
const MAX_ANALYSIS_SPLITS = 200;

function readSplits(database: Database, activityId: string, intervalKind: "km" | "mile"): StoredSplit[] {
  return database.prepare(`
    SELECT sequence, start_distance_meters AS startDistanceMeters, end_distance_meters AS endDistanceMeters,
      distance_meters AS distanceMeters, complete, started_at AS startedAt, ended_at AS endedAt,
      elapsed_seconds AS elapsedSeconds, moving_seconds AS movingSeconds, paused_seconds AS pausedSeconds,
      pause_count AS pauseCount, recording_gap_count AS recordingGapCount, pace_seconds_per_km AS paceSecondsPerKm,
      average_heart_rate AS averageHeartRate, max_heart_rate AS maxHeartRate, average_cadence AS averageCadence,
      average_power_watts AS averagePowerWatts, elevation_gain_meters AS elevationGainMeters,
      elevation_loss_meters AS elevationLossMeters, point_count AS pointCount,
      metrics_available_json AS metricsAvailableJson, distance_source AS distanceSource,
      derivation_version AS derivationVersion
    FROM activity_splits WHERE activity_id = ? AND interval_kind = ? ORDER BY sequence
  `).all(activityId, intervalKind) as StoredSplit[];
}

/** Why a telemetry analysis cannot run, stated without coordinates. */
function telemetryUnavailability(database: Database, activityId: string): { reason: string; distanceSource: string; qualityStatus: string } | null {
  const bounds = database.prepare("SELECT distance_source AS distanceSource FROM activity_bounds WHERE activity_id = ?").get(activityId) as { distanceSource: string } | undefined;
  const diagnostic = database.prepare("SELECT quality_status AS qualityStatus, withheld_reason AS withheldReason FROM activity_distance_diagnostics WHERE activity_id = ?").get(activityId) as { qualityStatus: string; withheldReason: string | null } | undefined;
  if (bounds === undefined) {
    return { reason: "No detailed file has been imported for this activity; run import_detailed_activities.", distanceSource: "none", qualityStatus: "unavailable" };
  }
  if (bounds.distanceSource === "none") {
    return {
      reason: diagnostic?.withheldReason ?? "This activity has no usable distance source for interval analysis.",
      distanceSource: bounds.distanceSource, qualityStatus: diagnostic?.qualityStatus ?? "unavailable",
    };
  }
  return null;
}

export function analyzeActivity(database: Database, activityId: string, analysisType: AnalysisType, intervalKind: "km" | "mile" = "km"): object {
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
  const identity = { id: activity.id, name: activity.name, sportType: activity.sportType, startedAt: activity.startedAt };
  const catalogSummary = { durationSeconds: activity.durationSeconds, distanceMeters: activity.distanceMeters, elevationGainMeters: activity.elevationGainMeters, averagePaceSecondsPerKm: pace };

  if (analysisType === "splits" || analysisType === "progression" || analysisType === "pauses") {
    const unavailable = telemetryUnavailability(database, activityId);
    if (unavailable !== null) {
      // Falling back is not an error: the catalog answer is still true, and
      // the caller is told exactly why the interval view is missing.
      return {
        found: true, activity: identity, analysisType, fellBackToCatalog: true,
        reason: unavailable.reason, distanceSource: unavailable.distanceSource, routeQualityStatus: unavailable.qualityStatus,
        analysis: catalogSummary,
        limitations: ["Catalog-only analysis: values come from the activity catalog, not from decoded telemetry."],
      };
    }
    const stored = readSplits(database, activityId, intervalKind);
    if (stored.length === 0) {
      return {
        found: true, activity: identity, analysisType, fellBackToCatalog: true,
        reason: "No splits are stored for this activity and interval; run import_detailed_activities.",
        analysis: catalogSummary,
        limitations: ["Catalog-only analysis: values come from the activity catalog, not from decoded telemetry."],
      };
    }
    const truncated = stored.length > MAX_ANALYSIS_SPLITS;
    const shown = stored.slice(0, MAX_ANALYSIS_SPLITS);
    const distanceSource = stored[0]!.distanceSource;
    const boundaryBasis = distanceSource === "supplied"
      ? "Interval boundaries come from per-point distance the source file recorded."
      : "Interval boundaries come from route progression normalized to the catalog total distance, not from measured per-point distance.";
    const common = {
      found: true, activity: identity, analysisType,
      intervalKind, intervalMeters: INTERVAL_METERS[intervalKind],
      distanceSource, derivationVersion: stored[0]!.derivationVersion,
      totalSplits: stored.length, truncated, maxSplits: MAX_ANALYSIS_SPLITS,
      boundaryBasis,
    };
    const limitations = [
      boundaryBasis,
      "Each split reports the metrics it actually carries; an absent metric is omitted rather than reported as zero.",
      "Coordinates are never returned by this tool.",
    ];

    if (analysisType === "splits") {
      return {
        ...common, limitations,
        analysis: {
          splits: shown.map((split) => ({
            sequence: split.sequence, startDistanceMeters: split.startDistanceMeters, endDistanceMeters: split.endDistanceMeters,
            distanceMeters: split.distanceMeters, complete: split.complete === 1,
            startedAt: split.startedAt, endedAt: split.endedAt,
            elapsedSeconds: split.elapsedSeconds, movingSeconds: split.movingSeconds,
            pausedSeconds: split.pausedSeconds, pauseCount: split.pauseCount, recordingGapCount: split.recordingGapCount,
            paceSecondsPerKm: split.paceSecondsPerKm,
            averageHeartRate: split.averageHeartRate, maxHeartRate: split.maxHeartRate,
            averageCadence: split.averageCadence, averagePowerWatts: split.averagePowerWatts,
            elevationGainMeters: split.elevationGainMeters, elevationLossMeters: split.elevationLossMeters,
            pointCount: split.pointCount, metricsAvailable: JSON.parse(split.metricsAvailableJson) as string[],
          })),
        },
      };
    }

    if (analysisType === "pauses") {
      const complete = stored.filter((split) => split.complete === 1);
      return {
        ...common, limitations,
        analysis: {
          totalPauseCount: stored.reduce((total, split) => total + split.pauseCount, 0),
          totalPausedSeconds: stored.reduce((total, split) => total + split.pausedSeconds, 0),
          totalRecordingGapCount: stored.reduce((total, split) => total + split.recordingGapCount, 0),
          totalMovingSeconds: stored.reduce((total, split) => total + (split.movingSeconds ?? 0), 0),
          totalElapsedSeconds: stored.reduce((total, split) => total + (split.elapsedSeconds ?? 0), 0),
          definition: "pausedSeconds is every second spent moving below 0.5 m/s. pauseCount is the number of distinct stops that lasted at least 5 s, so a device sampling through one stop reports a single pause and a brief dip below the threshold reports none. A recording gap is more than 30 s between points while still covering ground, reported separately because it is a hole in the data rather than a rest.",
          splitsWithPauses: shown.filter((split) => split.pauseCount > 0).map((split) => ({
            sequence: split.sequence, pauseCount: split.pauseCount, pausedSeconds: split.pausedSeconds,
            recordingGapCount: split.recordingGapCount,
          })),
          completeSplitCount: complete.length,
        },
      };
    }

    // Progression is the per-split series; the spec deliberately avoids a
    // second resampling mechanism for what splits already express.
    const paces = shown.filter((split) => split.complete === 1 && split.paceSecondsPerKm !== null);
    const first = paces[0]?.paceSecondsPerKm ?? null;
    const last = paces[paces.length - 1]?.paceSecondsPerKm ?? null;
    return {
      ...common, limitations,
      analysis: {
        series: shown.map((split) => ({
          sequence: split.sequence, complete: split.complete === 1,
          paceSecondsPerKm: split.paceSecondsPerKm,
          averageHeartRate: split.averageHeartRate, maxHeartRate: split.maxHeartRate,
          elevationGainMeters: split.elevationGainMeters, elevationLossMeters: split.elevationLossMeters,
          metricsAvailable: JSON.parse(split.metricsAvailableJson) as string[],
        })),
        // Positive means the closing complete split was slower than the opening
        // one. Null below two complete splits: comparing a split with itself
        // would report zero drift, which reads as even pacing rather than as
        // no comparison having been possible.
        paceDriftSecondsPerKm: paces.length >= 2 && first !== null && last !== null ? last - first : null,
        completeSplitsCompared: paces.length,
        definition: "Progression is the per-split series of pace, heart rate, and elevation change. Pace drift compares the last complete split to the first; partial splits are excluded because a short final interval is not comparable.",
      },
    };
  }

  const analysis = analysisType === "pace"
    ? { averagePaceSecondsPerKm: pace, definition: "Activity-level moving-time pace over the whole activity. Use analysisType splits or progression for per-interval pacing." }
    : analysisType === "intensity"
      ? { relativeEffort: activity.relativeEffort, trainingLoad: activity.trainingLoad, intensity: activity.intensity, averageHeartRate: activity.averageHeartRate, averageWatts: activity.averageWatts, definition: "Values are source-supplied catalog fields." }
      : catalogSummary;
  return {
    found: true, activity: identity, analysisType, analysis,
    limitations: [
      "Catalog-only analysis: values come from the activity catalog, not from decoded telemetry.",
      "Per-interval pacing, pauses, and progression are available through analysisType splits, pauses, or progression.",
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
