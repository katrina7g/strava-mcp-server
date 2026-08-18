import { Decoder, Stream } from "@garmin/fitsdk";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createGunzip } from "node:zlib";
import { SaxesParser } from "saxes";
import type { Database } from "./database.js";
import { fitOffsetMinutes, resolveActivityLocalTimes } from "./localtime.js";

const MAX_COMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 200 * 1024 * 1024;
const MAX_COMPRESSION_RATIO = 100;

export type StreamPoint = { timestamp: string | null; latitude: number | null; longitude: number | null; altitudeMeters: number | null; distanceMeters: number | null; heartRate: number | null; cadence: number | null; powerWatts: number | null; speedMetersPerSecond: number | null; sourcePayload?: Record<string, unknown> };
export type Lap = { startedAt: string | null; durationSeconds: number | null; distanceMeters: number | null; elevationGainMeters: number | null; averageHeartRate: number | null; averageCadence: number | null; averagePowerWatts: number | null; sourcePayload?: Record<string, unknown> };
type DetailedActivity = { format: "gpx" | "fit" | "fit.gz" | "tcx.gz"; points: StreamPoint[]; laps: Lap[]; utcOffsetMinutes: number | null };

function inRoot(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}
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

async function parseGpx(path: string): Promise<DetailedActivity> {
  const points: StreamPoint[] = []; let current: StreamPoint | undefined; let element = ""; let text = "";
  await parseXml(path, false,
    (name, attributes) => { element = name; text = ""; if (name === "trkpt") current = { timestamp: null, latitude: asNumber(Number(attributes.lat)), longitude: asNumber(Number(attributes.lon)), altitudeMeters: null, distanceMeters: null, heartRate: null, cadence: null, powerWatts: null, speedMetersPerSecond: null }; },
    (value) => { text += value; },
    (name) => { if (current !== undefined) { const value = text.trim(); if (name === "ele") current.altitudeMeters = asNumber(Number(value)); if (name === "time") current.timestamp = asDate(value); if (name === "hr") current.heartRate = asNumber(Number(value)); if (name === "cad") current.cadence = asNumber(Number(value)); if (name === "power") current.powerWatts = asNumber(Number(value)); if (name === "speed") current.speedMetersPerSecond = asNumber(Number(value)); if (name === "trkpt") { points.push(current); current = undefined; } } element = ""; text = ""; },
  );
  // GPX and TCX carry UTC only; no local offset can be recovered from them.
  return { format: "gpx", points, laps: [], utcOffsetMinutes: null };
}

async function parseTcx(path: string): Promise<DetailedActivity> {
  const points: StreamPoint[] = []; const laps: Lap[] = []; let current: StreamPoint | undefined; let lap: Lap | undefined; let text = "";
  await parseXml(path, true,
    (name, attributes) => { text = ""; if (name === "Trackpoint") current = { timestamp: null, latitude: null, longitude: null, altitudeMeters: null, distanceMeters: null, heartRate: null, cadence: null, powerWatts: null, speedMetersPerSecond: null }; if (name === "Lap") lap = { startedAt: asDate(attributes.StartTime), durationSeconds: null, distanceMeters: null, elevationGainMeters: null, averageHeartRate: null, averageCadence: null, averagePowerWatts: null }; },
    (value) => { text += value; },
    (name) => { const value = text.trim(); if (current !== undefined) { if (name === "Time") current.timestamp = asDate(value); if (name === "LatitudeDegrees") current.latitude = asNumber(Number(value)); if (name === "LongitudeDegrees") current.longitude = asNumber(Number(value)); if (name === "AltitudeMeters") current.altitudeMeters = asNumber(Number(value)); if (name === "DistanceMeters") current.distanceMeters = asNumber(Number(value)); if (name === "Value") current.heartRate = asNumber(Number(value)); if (name === "Cadence") current.cadence = asNumber(Number(value)); if (name === "Trackpoint") { points.push(current); current = undefined; } } if (lap !== undefined) { if (name === "TotalTimeSeconds") lap.durationSeconds = asNumber(Number(value)); if (name === "DistanceMeters" && current === undefined) lap.distanceMeters = asNumber(Number(value)); if (name === "Lap") { laps.push(lap); lap = undefined; } } text = ""; },
  );
  return { format: "tcx.gz", points, laps, utcOffsetMinutes: null };
}

async function parseFit(path: string, compressed: boolean): Promise<DetailedActivity> {
  const bytes = compressed ? await readGzipLimited(path) : await readFile(path);
  if (bytes.length > MAX_DECOMPRESSED_BYTES) throw new Error("FIT source exceeds import limit.");
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

export async function importDetailedActivityFiles(exportDir: string, database: Database, activityId?: string, timeZone?: string): Promise<object> {
  const root = resolve(exportDir); const files = database.prepare(`SELECT id, activity_id AS activityId, relative_path AS relativePath FROM activity_files WHERE activity_id IS NOT NULL ${activityId === undefined ? "" : "AND activity_id = ?"}`).all(...(activityId === undefined ? [] : [activityId])) as { id: number; activityId: string; relativePath: string }[];
  const results: { activityId: string; status: "decoded" | "skipped" | "failed"; pointCount?: number; lapCount?: number; utcOffsetMinutes?: number | null; error?: string }[] = [];
  for (const file of files) {
    const format = formatFor(file.relativePath); const path = resolve(root, file.relativePath);
    // Decode status and the decoded offset are facts about one file, so every
    // write below is keyed by the file rather than by its activity.
    if (format === null || !inRoot(root, path)) { database.prepare("UPDATE activity_files SET decode_status = ?, parse_error = ? WHERE id = ?").run("skipped", "Unsupported or unsafe detailed file reference", file.id); results.push({ activityId: file.activityId, status: "skipped" }); continue; }
    try {
      const detailed = await decode(path, format); const now = new Date().toISOString();
      const write = database.transaction(() => {
        database.prepare("DELETE FROM activity_streams WHERE activity_id = ?").run(file.activityId); database.prepare("DELETE FROM activity_laps WHERE activity_id = ?").run(file.activityId);
        const stream = database.prepare("INSERT INTO activity_streams (activity_id, sequence, timestamp, latitude, longitude, altitude_meters, distance_meters, heart_rate, cadence, power_watts, speed_meters_per_second, source_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        detailed.points.forEach((point, sequence) => stream.run(file.activityId, sequence, point.timestamp, point.latitude, point.longitude, point.altitudeMeters, point.distanceMeters, point.heartRate, point.cadence, point.powerWatts, point.speedMetersPerSecond, point.sourcePayload === undefined ? null : JSON.stringify(point.sourcePayload)));
        const lap = database.prepare("INSERT INTO activity_laps (activity_id, sequence, started_at, duration_seconds, distance_meters, elevation_gain_meters, average_heart_rate, average_cadence, average_power_watts, source_payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        detailed.laps.forEach((item, sequence) => lap.run(file.activityId, sequence, item.startedAt, item.durationSeconds, item.distanceMeters, item.elevationGainMeters, item.averageHeartRate, item.averageCadence, item.averagePowerWatts, item.sourcePayload === undefined ? null : JSON.stringify(item.sourcePayload)));
        const bounds = database.prepare(`SELECT COUNT(*) AS pointCount, MIN(timestamp) AS startedAt, MAX(timestamp) AS endedAt, MIN(latitude) AS minLatitude, MIN(longitude) AS minLongitude, MAX(latitude) AS maxLatitude, MAX(longitude) AS maxLongitude, MAX(distance_meters) AS totalDistanceMeters, SUM(CASE WHEN altitude_meters > previousAltitude THEN altitude_meters - previousAltitude ELSE 0 END) AS elevationGainMeters FROM (SELECT *, LAG(altitude_meters) OVER (ORDER BY sequence) AS previousAltitude FROM activity_streams WHERE activity_id = ?)` ).get(file.activityId) as Record<string, unknown>;
        database.prepare("INSERT OR REPLACE INTO activity_bounds (activity_id, point_count, started_at, ended_at, min_latitude, min_longitude, max_latitude, max_longitude, total_distance_meters, elevation_gain_meters, has_location, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(file.activityId, bounds.pointCount, bounds.startedAt, bounds.endedAt, bounds.minLatitude, bounds.minLongitude, bounds.maxLatitude, bounds.maxLongitude, bounds.totalDistanceMeters, bounds.elevationGainMeters, bounds.minLatitude === null ? 0 : 1, now);
        database.prepare("UPDATE activity_files SET format = ?, decode_status = 'decoded', parse_error = NULL, utc_offset_minutes = ? WHERE id = ?").run(format, detailed.utcOffsetMinutes, file.id);
      }); write(); results.push({ activityId: file.activityId, status: "decoded", pointCount: detailed.points.length, lapCount: detailed.laps.length, utcOffsetMinutes: detailed.utcOffsetMinutes });
    } catch (error) { database.prepare("UPDATE activity_files SET decode_status = 'failed', parse_error = ? WHERE id = ?").run("Detailed file could not be decoded", file.id); results.push({ activityId: file.activityId, status: "failed", error: "Detailed file could not be decoded" }); }
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
  if (!includeLocation) return { activityId, available: true, includeLocation: false, summary: bounds, message: "Coordinates are withheld by default. Set includeLocation to true for this single request." };
  const total = database.prepare("SELECT COUNT(*) AS count FROM activity_streams WHERE activity_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL").get(activityId) as { count: number };
  const stride = Math.max(1, Math.ceil(total.count / maxPoints));
  const coordinates = database.prepare("SELECT longitude, latitude FROM activity_streams WHERE activity_id = ? AND latitude IS NOT NULL AND longitude IS NOT NULL AND sequence % ? = 0 ORDER BY sequence LIMIT ?").all(activityId, stride, maxPoints) as { longitude: number; latitude: number }[];
  return { activityId, available: true, includeLocation: true, geometry: { type: "LineString", coordinates: coordinates.map((point) => [point.longitude, point.latitude]) }, summary: bounds, simplified: stride > 1 };
}
