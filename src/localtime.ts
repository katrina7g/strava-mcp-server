import type { Database } from "./database.js";

/** Where an activity's UTC offset came from, so a response can say so. */
export type OffsetSource = "fit-local-timestamp" | "configured-zone" | "none";

export type TimeBasis = "local" | "utc";

/**
 * Calendar buckets are grouped in local time, where a UTC boundary would
 * misfile an evening activity into the next day. Date-range filters stay on
 * the UTC instant, which is unambiguous and needs no basis. Callers select an
 * expression by key; no caller-supplied text reaches SQL.
 */
export const TIME_COLUMNS: Readonly<Record<TimeBasis, string>> = {
  local: "COALESCE(started_at_local, started_at)",
  utc: "started_at",
};

export type OffsetCoverage = Readonly<Record<OffsetSource, number>>;

const MAXIMUM_OFFSET_MINUTES = 14 * 60;

/**
 * FIT records both a UTC timestamp and a local one, so their difference is the
 * offset the device itself observed: correct across daylight-saving changes and
 * while travelling. Seconds are counted from the FIT epoch, 1989-12-31T00:00:00Z.
 */
const FIT_EPOCH_SECONDS = 631_065_600;

export function fitOffsetMinutes(activity: Record<string, unknown> | undefined): number | null {
  if (activity === undefined) return null;
  const timestamp = activity.timestamp;
  if (!(timestamp instanceof Date) || Number.isNaN(timestamp.valueOf())) return null;
  const local = activity.localTimestamp;
  const localMilliseconds = typeof local === "number" && Number.isFinite(local)
    ? (local + FIT_EPOCH_SECONDS) * 1000
    : local instanceof Date && !Number.isNaN(local.valueOf()) ? local.valueOf() : null;
  if (localMilliseconds === null) return null;
  const minutes = Math.round((localMilliseconds - timestamp.valueOf()) / 60_000);
  return Math.abs(minutes) <= MAXIMUM_OFFSET_MINUTES ? minutes : null;
}

/**
 * Derives a zone's offset for one instant by formatting it in that zone and
 * comparing the wall-clock result with UTC. This works on any ICU build and
 * handles daylight saving and the 30- and 45-minute zones.
 */
export function offsetMinutesForZone(instant: Date, timeZone: string): number | null {
  if (Number.isNaN(instant.valueOf())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(instant);
    const field = (type: string): number => Number(parts.find((part) => part.type === type)?.value);
    // Some ICU builds report midnight as hour 24 under hour12: false.
    const wallClock = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour") % 24, field("minute"), field("second"));
    return Number.isNaN(wallClock) ? null : Math.round((wallClock - instant.valueOf()) / 60_000);
  } catch {
    return null;
  }
}

/** Local wall-clock time, stored without a zone marker so SQLite date
 * functions group it by local calendar boundaries. */
export function localWallClock(startedAt: string, offsetMinutes: number): string | null {
  const instant = new Date(startedAt);
  if (Number.isNaN(instant.valueOf())) return null;
  return new Date(instant.valueOf() + offsetMinutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "");
}

/**
 * Resolves every observed activity's local time from the best available
 * source: a per-activity offset decoded from FIT, then the configured zone,
 * then none. The reference export has 325 activities, so recomputing all of
 * them costs less than tracking which inputs changed.
 */
export function resolveActivityLocalTimes(database: Database, timeZone?: string): OffsetCoverage {
  const rows = database.prepare(`
    SELECT a.id AS id, a.started_at AS startedAt,
      (SELECT f.utc_offset_minutes FROM activity_files f
        WHERE f.activity_id = a.id AND f.utc_offset_minutes IS NOT NULL LIMIT 1) AS fileOffset
    FROM activities a WHERE a.started_at IS NOT NULL
  `).all() as { id: string; startedAt: string; fileOffset: number | null }[];

  const update = database.prepare("UPDATE activities SET started_at_local = ?, utc_offset_minutes = ?, offset_source = ? WHERE id = ?");
  const coverage = { "fit-local-timestamp": 0, "configured-zone": 0, none: 0 };
  const apply = database.transaction(() => {
    for (const row of rows) {
      const zoneOffset = timeZone === undefined ? null : offsetMinutesForZone(new Date(row.startedAt), timeZone);
      const offset = row.fileOffset ?? zoneOffset;
      const source: OffsetSource = row.fileOffset !== null
        ? "fit-local-timestamp"
        : offset === null ? "none" : "configured-zone";
      update.run(localWallClock(row.startedAt, offset ?? 0), offset, source, row.id);
      coverage[source] += 1;
    }
  });
  apply();
  return Object.freeze(coverage);
}

export function offsetCoverage(database: Database): OffsetCoverage {
  const rows = database.prepare(`
    SELECT COALESCE(offset_source, 'none') AS source, COUNT(*) AS activities
    FROM activities WHERE observation_status = 'observed' GROUP BY source
  `).all() as { source: string; activities: number }[];
  const coverage = { "fit-local-timestamp": 0, "configured-zone": 0, none: 0 };
  for (const row of rows) {
    if (row.source in coverage) coverage[row.source as OffsetSource] = row.activities;
  }
  return Object.freeze(coverage);
}
