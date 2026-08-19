import { Decoder, Stream } from "@garmin/fitsdk";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createGunzip } from "node:zlib";
import { SaxesParser } from "saxes";
import type { Database } from "./database.js";
import { elevationGainMeters } from "./elevation.js";
import { logInternalError } from "./errors.js";
import { simplifyToLimit } from "./geometry.js";
import { fitOffsetMinutes, resolveActivityLocalTimes } from "./localtime.js";
import { withinRoot } from "./paths.js";

const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export type StreamPoint = { timestamp: string | null; latitude: number | null; longitude: number | null; altitudeMeters: number | null; distanceMeters: number | null; heartRate: number | null; cadence: number | null; powerWatts: number | null; speedMetersPerSecond: number | null; sourcePayload?: Record<string, unknown> };
export type Lap = { startedAt: string | null; durationSeconds: number | null; distanceMeters: number | null; elevationGainMeters: number | null; averageHeartRate: number | null; averageCadence: number | null; averagePowerWatts: number | null; sourcePayload?: Record<string, unknown> };
type DetailedActivity = { format: "gpx" | "fit" | "fit.gz" | "tcx.gz"; points: StreamPoint[]; laps: Lap[]; utcOffsetMinutes: number | null };

function asNumber(value: unknown): number | null { return typeof value === "number" && Number.isFinite(value) ? value : null; }
function asDate(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value !== "string") return null;
  const date = new Date(value); return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
function semicircles(value: unknown): number | null { const number = asNumber(value); return number === null ? null : number * (180 / 2 ** 31); }
function formatFor(path: string): DetailedActivity["format"] | null {
  if (path.endsWith(".fit.gz")) return "fit.gz";
  if (path.endsWith(".tcx.gz")) return "tcx.gz";
  if (path.endsWith(".fit")) return "fit";
  if (path.endsWith(".gpx")) return "gpx";
  return null;
}

async function readGzipLimited(path: string): Promise<Buffer> {
  const compressedSize = (await stat(path)).size;
  if (compressedSize > MAX_COMPRESSED_BYTES) throw new Error("Compressed source exceeds import limit.");
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []; let total = 0; const input = createReadStream(path); const gzip = createGunzip();
    const fail = (message: string) => { input.destroy(); gzip.destroy(); reject(new Error(message)); };
    gzip.on("data", (chunk: Buffer) => { total += chunk.length; if (total > MAX_DECOMPRESSED_BYTES || total > compressedSize * MAX_COMPRESSION_RATIO) fail("Decompressed source exceeds import limit."); else chunks.push(chunk); });
    input.on("error", () => fail("Compressed source could not be read.")); gzip.on("error", () => fail("Compressed source is invalid."));
    gzip.on("end", () => resolvePromise(Buffer.concat(chunks))); input.pipe(gzip);
  });
}

async function parseXml(path: string, compressed: boolean, onOpen: (name: string, attributes: Record<string, string>) => void, onText: (text: string) => void, onClose: (name: string) => void): Promise<void> {
  const parser = new SaxesParser({ xmlns: true }); let error: Error | undefined;
  parser.on("doctype", () => { error = new Error("DOCTYPE is not permitted."); });
  parser.on("error", (cause) => { error = cause; });
  parser.on("opentag", (tag) => onOpen(tag.local, Object.fromEntries(Object.entries(tag.attributes).map(([key, value]) => [key, value.value]))));
  parser.on("text", onText); parser.on("closetag", (tag) => onClose(tag.local));
  const source = compressed ? await readGzipLimited(path) : createReadStream(path);
  if (Buffer.isBuffer(source)) {
    const normalized = source.toString("utf8").replace(/^\uFEFF?\s*/, ""); parser.write(normalized).close();
  } else {
    await new Promise<void>((resolvePromise, reject) => {
      source.setEncoding("utf8"); source.on("data", (chunk: string) => { if (!error) parser.write(chunk); }); source.on("error", reject); source.on("end", () => { parser.close(); error === undefined ? resolvePromise() : reject(error); });
    });
  }
  if (error !== undefined) throw error;
}

/**
 * Real GPX extension fields nest an extra wrapper element deep — a device's
 * TrackPointExtension between `<extensions>` and `<gpxtpx:hr>` — so the
 * immediate-parent check used for `ele`/`time` is too strict for them.
 * Requiring an `extensions` ancestor anywhere on the stack matches both the
 * reference export's real files and the flatter shape used in tests, while
 * still refusing a same-named element that appears outside any extension.
 */
async function parseGpx(path: string): Promise<DetailedActivity> {
  const points: StreamPoint[] = []; let current: StreamPoint | undefined; const stack: string[] = []; let text = "";
  await parseXml(path, false,
    (name, attributes) => { stack.push(name); text = ""; if (name === "trkpt") current = { timestamp: null, latitude: asNumber(Number(attributes.lat)), longitude: asNumber(Number(attributes.lon)), altitudeMeters: null, distanceMeters: null, heartRate: null, cadence: null, powerWatts: null, speedMetersPerSecond: null }; },
    (value) => { text += value; },
    (name) => {
      if (current !== undefined) {
        const value = text.trim();
        const parent = stack[stack.length - 2];
        const withinExtensions = stack.slice(0, -1).includes("extensions");
        if (name === "ele" && parent === "trkpt") current.altitudeMeters = asNumber(Number(value));
        if (name === "time" && parent === "trkpt") current.timestamp = asDate(value);
        if (name === "hr" && withinExtensions) current.heartRate = asNumber(Number(value));
        if (name === "cad" && withinExtensions) current.cadence = asNumber(Number(value));
        if (name === "power" && withinExtensions) current.powerWatts = asNumber(Number(value));
        if (name === "speed" && withinExtensions) current.speedMetersPerSecond = asNumber(Number(value));
        if (name === "trkpt") { points.push(current); current = undefined; }
      }
      stack.pop(); text = "";
    },
  );
  // GPX and TCX carry UTC only; no local offset can be recovered from them.
  return { format: "gpx", points, laps: [], utcOffsetMinutes: null };
}

async function parseTcx(path: string): Promise<DetailedActivity> {
  const points: StreamPoint[] = []; const laps: Lap[] = []; let current: StreamPoint | undefined; let lap: Lap | undefined; const stack: string[] = []; let text = "";
  await parseXml(path, true,
    (name, attributes) => { stack.push(name); text = ""; if (name === "Trackpoint") current = { timestamp: null, latitude: null, longitude: null, altitudeMeters: null, distanceMeters: null, heartRate: null, cadence: null, powerWatts: null, speedMetersPerSecond: null }; if (name === "Lap") lap = { startedAt: asDate(attributes.StartTime), durationSeconds: null, distanceMeters: null, elevationGainMeters: null, averageHeartRate: null, averageCadence: null, averagePowerWatts: null }; },
    (value) => { text += value; },
    (name) => {
      const value = text.trim();
      // `<Value>` appears under more than one parent in TCX (heart rate today,
      // potentially other sensor extensions from another device); only its
      // immediate parent identifies what it means.
      const parent = stack[stack.length - 2];
      if (current !== undefined) {
        if (name === "Time") current.timestamp = asDate(value);
        if (name === "LatitudeDegrees") current.latitude = asNumber(Number(value));
        if (name === "LongitudeDegrees") current.longitude = asNumber(Number(value));
        if (name === "AltitudeMeters") current.altitudeMeters = asNumber(Number(value));
        if (name === "DistanceMeters") current.distanceMeters = asNumber(Number(value));
        if (name === "Value" && parent === "HeartRateBpm") current.heartRate = asNumber(Number(value));
        if (name === "Cadence") current.cadence = asNumber(Number(value));
        if (name === "Trackpoint") { points.push(current); current = undefined; }
      }
      if (lap !== undefined) {
        if (name === "TotalTimeSeconds") lap.durationSeconds = asNumber(Number(value));
        if (name === "DistanceMeters" && current === undefined) lap.distanceMeters = asNumber(Number(value));
        if (name === "Lap") { laps.push(lap); lap = undefined; }
      }
      stack.pop(); text = "";
    },
  );
  return { format: "tcx.gz", points, laps, utcOffsetMinutes: null };
}

async function parseFit(path: string, compressed: boolean): Promise<DetailedActivity> {
  if (!compressed && (await stat(path)).size > MAX_DECOMPRESSED_BYTES) throw new Error("FIT source exceeds import limit.");
  const bytes = compressed ? await readGzipLimited(path) : await readFile(path);
  const decoder = new Decoder(Stream.fromBuffer(bytes));
  if (!decoder.isFIT()) throw new Error("Source is not a FIT file.");
  const { messages, errors } = decoder.read();
  if (errors.length) throw new Error("FIT decoder reported errors.");
  const records = messages.recordMesgs ?? []; const sourceLaps = messages.lapMesgs ?? [];
  const activity = (messages.activityMesgs ?? [])[0] as Record<string, unknown> | undefined;
  const points = records.map((record: Record<string, unknown>) => ({ timestamp: asDate(record.timestamp), latitude: semicircles(record.positionLat), longitude: semicircles(record.positionLong), altitudeMeters: asNumber(record.enhancedAltitude) ?? asNumber(record.altitude), distanceMeters: asNumber(record.distance), heartRate: asNumber(record.heartRate), cadence: asNumber(record.cadence), powerWatts: asNumber(record.power), speedMetersPerSecond: asNumber(record.enhancedSpeed) ?? asNumber(record.speed) }));
  const laps = sourceLaps.map((lap: Record<string, unknown>) => ({ startedAt: asDate(lap.startTime), durationSeconds: asNumber(lap.totalTimerTime) ?? asNumber(lap.totalElapsedTime), distanceMeters: asNumber(lap.totalDistance), elevationGainMeters: asNumber(lap.totalAscent), averageHeartRate: asNumber(lap.avgHeartRate), averageCadence: asNumber(lap.avgCadence), averagePowerWatts: asNumber(lap.avgPower) }));
  return { format: compressed ? "fit.gz" : "fit", points, laps, utcOffsetMinutes: fitOffsetMinutes(activity) };
}

async function decode(path: string, format: DetailedActivity["format"]): Promise<DetailedActivity> {
  if (format === "gpx") return parseGpx(path);
  if (format === "tcx.gz") return parseTcx(path);
  return parseFit(path, format === "fit.gz");
}

// Sensor/GPS altitude jitters by less than this between samples; counting
// every positive tick as "climbed" overstates gain against the source
// figure. See elevation.ts for why this is a hysteresis band, not a
// per-step gate.
const ELEVATION_NOISE_THRESHOLD_METERS = 1;

export async function importDetailedActivityFiles(exportDir: string, database: Database, activityId?: string, timeZone?: string): Promise<object> {
  const root = resolve(exportDir); const files = database.prepare(`SELECT id, activity_id AS activityId, relative_path AS relativePath FROM activity_files WHERE activity_id IS NOT NULL ${activityId === undefined ? "" : "AND activity_id = ?"}`).all(...(activityId === undefined ? [] : [activityId])) as { id: number; activityId: string; relativePath: string }[];
  // A file's detail row can outlive the source that produced it — an export
  // may drop a file between snapshots. Decoding only proceeds for paths the
  // latest validation actually observed, not merely ones once recorded.
  const observedPaths = new Set((database.prepare(`
    SELECT relative_path AS relativePath FROM source_manifest
    WHERE snapshot_id = (SELECT id FROM export_snapshots WHERE outcome != 'running' ORDER BY id DESC LIMIT 1)
  `).all() as { relativePath: string }[]).map((row) => row.relativePath));
  const results: { activityId: string; status: "decoded" | "skipped" | "failed"; pointCount?: number; lapCount?: number; utcOffsetMinutes?: number | null; error?: string }[] = [];
  for (const file of files) {
    const format = formatFor(file.relativePath); const path = resolve(root, file.relativePath);
    // Decode status and the decoded offset are facts about one file, so every
    // write below is keyed by the file rather than by its activity.
    if (format === null || !withinRoot(root, path) || !observedPaths.has(file.relativePath)) {
      database.prepare("UPDATE activity_files SET decode_status = ?, parse_error = ? WHERE id = ?").run("skipped", "Unsupported, unsafe, or unvalidated detailed file reference", file.id);
      results.push({ activityId: file.activityId, status: "skipped" });
      continue;
    }
    try {
      const detailed = await decode(path, format); const now = new Date().toISOString();
      const write = database.transaction(() => {
        database.prepare("DELETE FROM activity_streams WHERE activity_id = ?").run(file.activityId); database.prepare("DELETE FROM activity_laps WHERE activity_id = ?").run(file.activityId);
        const stream = database.prepare("INSERT INTO activity_streams (activity_id, sequence, timestamp, latitude, longitude, altitude_meters, distance_meters, heart_rate, cadence, power_watts, speed_meters_per_second, source_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        detailed.points.forEach((point, sequence) => stream.run(file.activityId, sequence, point.timestamp, point.latitude, point.longitude, point.altitudeMeters, point.distanceMeters, point.heartRate, point.cadence, point.powerWatts, point.speedMetersPerSecond, point.sourcePayload === undefined ? null : JSON.stringify(point.sourcePayload)));
        const lap = database.prepare("INSERT INTO activity_laps (activity_id, sequence, started_at, duration_seconds, distance_meters, elevation_gain_meters, average_heart_rate, average_cadence, average_power_watts, source_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        detailed.laps.forEach((item, sequence) => lap.run(file.activityId, sequence, item.startedAt, item.durationSeconds, item.distanceMeters, item.elevationGainMeters, item.averageHeartRate, item.averageCadence, item.averagePowerWatts, item.sourcePayload === undefined ? null : JSON.stringify(item.sourcePayload)));
        const bounds = database.prepare(`
          SELECT COUNT(*) AS pointCount, MIN(timestamp) AS startedAt, MAX(timestamp) AS endedAt,
            MIN(latitude) AS minLatitude, MIN(longitude) AS minLongitude, MAX(latitude) AS maxLatitude, MAX(longitude) AS maxLongitude,
            MAX(distance_meters) AS totalDistanceMeters
          FROM activity_streams WHERE activity_id = ?
        `).get(file.activityId) as Record<string, unknown>;
        // Hysteresis needs the ordered series itself, not an aggregate SQL can
        // express in one pass — see elevation.ts.
        const altitudes = (database.prepare("SELECT altitude_meters AS altitude FROM activity_streams WHERE activity_id = ? ORDER BY sequence").all(file.activityId) as { altitude: number | null }[]).map((row) => row.altitude);
        const gain = elevationGainMeters(altitudes, ELEVATION_NOISE_THRESHOLD_METERS);
        database.prepare("INSERT OR REPLACE INTO activity_bounds (activity_id, point_count, started_at, ended_at, min_latitude, min_longitude, max_latitude, max_longitude, total_distance_meters, elevation_gain_meters, has_location, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(file.activityId, bounds.pointCount, bounds.startedAt, bounds.endedAt, bounds.minLatitude, bounds.minLongitude, bounds.maxLatitude, bounds.maxLongitude, bounds.totalDistanceMeters, gain, bounds.minLatitude === null ? 0 : 1, now);
        database.prepare("UPDATE activity_files SET format = ?, decode_status = 'decoded', parse_error = NULL, utc_offset_minutes = ? WHERE id = ?").run(format, detailed.utcOffsetMinutes, file.id);
      }); write(); results.push({ activityId: file.activityId, status: "decoded", pointCount: detailed.points.length, lapCount: detailed.laps.length, utcOffsetMinutes: detailed.utcOffsetMinutes });
    } catch (error) {
      logInternalError(`decoding ${file.relativePath}`, error);
      database.prepare("UPDATE activity_files SET decode_status = 'failed', parse_error = ? WHERE id = ?").run("Detailed file could not be decoded", file.id);
      results.push({ activityId: file.activityId, status: "failed", error: "Detailed file could not be decoded" });
    }
  }
  // A newly decoded FIT offset supersedes the configured-zone fallback.
  const coverage = resolveActivityLocalTimes(database, timeZone);
  return { decoded: results.filter((result) => result.status === "decoded").length, failed: results.filter((result) => result.status === "failed").length, skipped: results.filter((result) => result.status === "skipped").length, offsetCoverage: coverage, results };
}

/**
 * Bounds derive total distance from per-point distance, which GPX never
 * supplies and TCX supplies only per lap: 222 of the 325 activities in the
 * reference export have none. The catalog carries a total for every activity,
 * so it is the fallback, and the source is always stated.
 */
export function resolveTotalDistance(streamDistance: number | null, catalogDistance: number | null): { meters: number | null; source: "stream" | "catalog" | "none" } {
  if (streamDistance !== null) return { meters: streamDistance, source: "stream" };
  if (catalogDistance !== null) return { meters: catalogDistance, source: "catalog" };
  return { meters: null, source: "none" };
}

const LOCATION_FIELDS = new Set(["latitude", "longitude"]);

export function getActivityStream(database: Database, activityId: string, fields: readonly string[], includeLocation: boolean, maxPoints: number, startTime?: string, endTime?: string): object {
  const allowed = { timestamp: "timestamp", altitudeMeters: "altitude_meters", distanceMeters: "distance_meters", heartRate: "heart_rate", cadence: "cadence", powerWatts: "power_watts", speedMetersPerSecond: "speed_meters_per_second", latitude: "latitude", longitude: "longitude" } as const;
  const requested = fields.length ? fields : ["timestamp", "distanceMeters", "heartRate", "cadence", "powerWatts", "speedMetersPerSecond"];
  const permitted = requested.filter((field): field is keyof typeof allowed => field in allowed);
  // Naming a coordinate field is not consent to receive it: exact location
  // requires the explicit per-request opt-in, and it is never carried over.
  const withheldFields = includeLocation ? [] : permitted.filter((field) => LOCATION_FIELDS.has(field));
  const selected = permitted.filter((field) => includeLocation || !LOCATION_FIELDS.has(field));
  const select = selected.map((field) => `${allowed[field]} AS ${field}`).join(", "); const where = ["activity_id = ?"]; const values: unknown[] = [activityId];
  if (startTime !== undefined) { where.push("timestamp >= ?"); values.push(startTime); } if (endTime !== undefined) { where.push("timestamp < ?"); values.push(endTime); }
  const total = database.prepare(`SELECT COUNT(*) AS count FROM activity_streams WHERE ${where.join(" AND ")}`).get(...values) as { count: number };
  const points = selected.length ? database.prepare(`SELECT ${select} FROM activity_streams WHERE ${where.join(" AND ")} ORDER BY sequence LIMIT ?`).all(...values, maxPoints) : [];
  // A field a source never recorded reads as a column of nulls, which must not
  // be mistaken for measured zeroes, so each field reports how much it has.
  const availabilitySelect = selected.map((field) => `SUM(${allowed[field]} IS NOT NULL) AS ${field}`).join(", ");
  const fieldAvailability = selected.length
    ? database.prepare(`SELECT ${availabilitySelect} FROM activity_streams WHERE ${where.join(" AND ")}`).get(...values)
    : {};
  return {
    activityId, fields: selected, points, totalPoints: total.count, truncated: total.count > maxPoints,
    fieldAvailability, includeLocation,
    ...(withheldFields.length ? { withheldFields, withheldReason: "Coordinates are withheld unless includeLocation is true. The opt-in applies to this request only." } : {}),
    note: "fieldAvailability counts points carrying each field across the selected window. A null value means the source did not record it, not zero.",
  };
}

const DEFAULT_ROUTE_TOLERANCE_METERS = 5;

export function getActivityRoute(database: Database, activityId: string, includeLocation: boolean, maxPoints: number): object {
  const stored = database.prepare(`
    SELECT b.point_count AS pointCount, b.started_at AS startedAt, b.ended_at AS endedAt,
      b.total_distance_meters AS streamDistanceMeters, a.distance_meters AS catalogDistanceMeters,
      b.elevation_gain_meters AS elevationGainMeters, b.has_location AS hasLocation
    FROM activity_bounds b LEFT JOIN activities a ON a.id = b.activity_id WHERE b.activity_id = ?
  `).get(activityId) as { pointCount: number; startedAt: string | null; endedAt: string | null; streamDistanceMeters: number | null; catalogDistanceMeters: number | null; elevationGainMeters: number | null; hasLocation: number } | undefined;
  if (stored === undefined) return { activityId, available: false, message: "No detailed route has been imported for this activity." };
  const { streamDistanceMeters, catalogDistanceMeters, ...rest } = stored;
  const distance = resolveTotalDistance(streamDistanceMeters, catalogDistanceMeters);
  const bounds = { ...rest, totalDistanceMeters: distance.meters, totalDistanceSource: distance.source };
  // elevationGainMeters here is computed from device altitude with basic
  // hysteresis smoothing, not Strava's own corrected figure; the two can
  // diverge, especially on undulating terrain where server-side elevation
  // correction typically reports less gain than raw device altitude.
  const definitions = { elevationGainMeters: "Derived from device altitude with noise smoothing; may diverge from Strava's own corrected value." };
  if (!includeLocation) return { activityId, available: true, includeLocation: false, summary: bounds, definitions, message: "Coordinates are withheld by default. Set includeLocation to true for this single request." };
  const source = database.prepare("SELECT longitude, latitude FROM activity_streams WHERE activity_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY sequence").all(activityId) as { longitude: number; latitude: number }[];
  const { points: reduced, toleranceMeters } = simplifyToLimit(source, maxPoints, DEFAULT_ROUTE_TOLERANCE_METERS);
  const simplified = reduced.length < source.length;
  return {
    activityId, available: true, includeLocation: true,
    geometry: { type: "LineString", coordinates: reduced.map((point) => [point.longitude, point.latitude]) },
    summary: bounds, simplified, definitions,
    ...(simplified ? { simplificationToleranceMeters: toleranceMeters } : {}),
  };
}
