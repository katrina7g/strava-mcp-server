import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { extname } from "node:path";
import type { Database } from "./database.js";
import { resolveActivityLocalTimes, type OffsetCoverage } from "./localtime.js";
import { parseCsv } from "./validator.js";

/** Version 3 reads `Activity Date` as UTC; bumping it re-imports stored rows. */
export const ACTIVITY_CATALOG_COLUMN_MAP_VERSION = 3;

export type ColumnType = "string" | "number" | "integer" | "boolean" | "date";
export type ColumnDefinition = Readonly<{
  field: string;
  sourceHeader: string;
  occurrence: number;
  type: ColumnType;
}>;

/**
 * Source-specific semantics for the observed Strava activities.csv layout.
 * `occurrence` is one-based because the export contains repeated headers.
 * The complete positional header map is retained independently for audit.
 */
export const ACTIVITY_CATALOG_COLUMNS_V1: readonly ColumnDefinition[] = [
  { field: "activityId", sourceHeader: "Activity ID", occurrence: 1, type: "string" },
  { field: "startedAt", sourceHeader: "Activity Date", occurrence: 1, type: "date" },
  { field: "name", sourceHeader: "Activity Name", occurrence: 1, type: "string" },
  { field: "sportType", sourceHeader: "Activity Type", occurrence: 1, type: "string" },
  { field: "description", sourceHeader: "Activity Description", occurrence: 1, type: "string" },
  { field: "elapsedSeconds", sourceHeader: "Elapsed Time", occurrence: 1, type: "integer" },
  { field: "distanceMiles", sourceHeader: "Distance", occurrence: 1, type: "number" },
  { field: "catalogFilename", sourceHeader: "Filename", occurrence: 1, type: "string" },
  { field: "movingSeconds", sourceHeader: "Moving Time", occurrence: 1, type: "integer" },
  { field: "distanceMeters", sourceHeader: "Distance", occurrence: 2, type: "number" },
  { field: "elevationGainMeters", sourceHeader: "Elevation Gain", occurrence: 1, type: "number" },
  { field: "averageHeartRate", sourceHeader: "Average Heart Rate", occurrence: 1, type: "number" },
  { field: "averageWatts", sourceHeader: "Average Watts", occurrence: 1, type: "number" },
  { field: "relativeEffort", sourceHeader: "Relative Effort", occurrence: 1, type: "number" },
  { field: "trainingLoad", sourceHeader: "Training Load", occurrence: 1, type: "number" },
  { field: "intensity", sourceHeader: "Intensity", occurrence: 1, type: "number" },
  { field: "commute", sourceHeader: "Commute", occurrence: 1, type: "boolean" },
];

export type PositionalColumn = Readonly<{
  index: number;
  sourceHeader: string;
  internalName: string;
}>;

export type CatalogParseIssue = Readonly<{
  code: "CATALOG_REQUIRED_FIELD_MISSING" | "CATALOG_VALUE_INVALID";
  field: string;
  message: string;
}>;

export type NormalizedActivityCatalogRow = Readonly<{
  rowNumber: number;
  rowHash: string;
  rawValues: Readonly<Record<string, string>>;
  parsedValues: Readonly<Record<string, string | number | boolean | null>>;
  issues: readonly CatalogParseIssue[];
}>;

export type CatalogImportSummary = Readonly<{
  snapshotId: number;
  inserted: number;
  changed: number;
  unchanged: number;
  noLongerObserved: number;
  invalid: number;
  offsetCoverage: OffsetCoverage;
}>;

function internalName(header: string, occurrence: number): string {
  const base = header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "unnamed";
  return occurrence === 1 ? base : `${base}__${occurrence}`;
}

export function buildPositionalColumnMap(headers: readonly string[]): PositionalColumn[] {
  const occurrences = new Map<string, number>();
  return headers.map((sourceHeader, index) => {
    const occurrence = (occurrences.get(sourceHeader) ?? 0) + 1;
    occurrences.set(sourceHeader, occurrence);
    return { index, sourceHeader, internalName: internalName(sourceHeader, occurrence) };
  });
}

function nullableText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseNumber(value: string | undefined, integer: boolean): number | null {
  const text = nullableText(value);
  if (text === null || !/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && (!integer || Number.isInteger(number)) ? number : null;
}

function parseBoolean(value: string | undefined): boolean | null {
  const text = nullableText(value)?.toLowerCase();
  if (text === null) return null;
  if (text === "true" || text === "1") return true;
  if (text === "false" || text === "0") return false;
  return null;
}

/**
 * Export timestamps are UTC but carry no zone marker: a catalog value of
 * `Mar 27, 2026, 1:28:59 AM` is the same instant as its linked GPX
 * `2026-03-27T01:28:59Z`. A lenient `new Date` resolves that format in the
 * host's zone, which would make the stored instant depend on where the
 * importer ran. Commas are optional because not every export writes them.
 */
const EXPORT_DATE_PATTERN = /^([A-Z][a-z]{2}) (\d{1,2}),? (\d{4}),? (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/;
/** A future export may switch to ISO-8601; accept it only when it states a zone. */
const ZONED_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const MONTH_INDEX: Readonly<Record<string, number>> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

function parseExportDate(match: RegExpExecArray): string | null {
  const month = MONTH_INDEX[match[1]!];
  const day = Number(match[2]);
  const hour12 = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month === undefined || hour12 < 1 || hour12 > 12 || minute > 59 || second > 59) return null;
  const hour = (hour12 % 12) + (match[7] === "PM" ? 12 : 0);
  const instant = new Date(Date.UTC(Number(match[3]), month, day, hour, minute, second));
  // Date.UTC rolls impossible components over instead of rejecting them, so a
  // value such as `Feb 30` must be caught by comparing the result back.
  return instant.getUTCMonth() === month && instant.getUTCDate() === day ? instant.toISOString() : null;
}

function parseDate(value: string | undefined): string | null {
  const text = nullableText(value);
  if (text === null) return null;
  const match = EXPORT_DATE_PATTERN.exec(text);
  if (match !== null) return parseExportDate(match);
  if (!ZONED_ISO_PATTERN.test(text)) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.valueOf()) ? null : parsed.toISOString();
}

function parseValue(value: string | undefined, type: ColumnType): string | number | boolean | null {
  if (type === "string") return nullableText(value);
  if (type === "number") return parseNumber(value, false);
  if (type === "integer") return parseNumber(value, true);
  if (type === "boolean") return parseBoolean(value);
  return parseDate(value);
}

function hashRow(headers: readonly string[], values: readonly string[]): string {
  // Hash positional values and the exact source header sequence; either a
  // header ordering or value change is therefore an observable catalog change.
  return createHash("sha256").update(JSON.stringify({ headers, values })).digest("hex");
}

export function normalizeActivityCatalogRow(
  headers: readonly string[],
  values: readonly string[],
  rowNumber: number,
): NormalizedActivityCatalogRow {
  const map = buildPositionalColumnMap(headers);
  const rawValues: Record<string, string> = {};
  for (const column of map) rawValues[column.internalName] = values[column.index] ?? "";

  const issues: CatalogParseIssue[] = [];
  const parsedValues: Record<string, string | number | boolean | null> = {};
  for (const definition of ACTIVITY_CATALOG_COLUMNS_V1) {
    const column = map.find((candidate) => candidate.sourceHeader === definition.sourceHeader && candidate.internalName === internalName(definition.sourceHeader, definition.occurrence));
    const rawValue = column === undefined ? undefined : values[column.index];
    const parsedValue = parseValue(rawValue, definition.type);
    parsedValues[definition.field] = parsedValue;
    if (definition.field === "activityId" && parsedValue === null) {
      issues.push({ code: "CATALOG_REQUIRED_FIELD_MISSING", field: definition.field, message: "Activity ID is required." });
    } else if (nullableText(rawValue) !== null && parsedValue === null) {
      issues.push({ code: "CATALOG_VALUE_INVALID", field: definition.field, message: `Expected ${definition.type} value.` });
    }
  }

  return Object.freeze({
    rowNumber,
    rowHash: hashRow(headers, values),
    rawValues: Object.freeze(rawValues),
    parsedValues: Object.freeze(parsedValues),
    issues: Object.freeze(issues),
  });
}

function value<T extends string | number | boolean>(row: NormalizedActivityCatalogRow, field: string): T | null {
  return (row.parsedValues[field] as T | null | undefined) ?? null;
}

function parseStatus(row: NormalizedActivityCatalogRow): "valid" | "invalid" {
  return row.issues.length === 0 ? "valid" : "invalid";
}

function activityFileFormat(path: string): string {
  if (path.endsWith(".fit.gz")) return "fit.gz";
  if (path.endsWith(".tcx.gz")) return "tcx.gz";
  return extname(path).slice(1).toLowerCase() || "unknown";
}

/**
 * Imports one already-validated activities.csv into its validation snapshot.
 * Source rows are always retained; malformed or identity-less rows are never
 * allowed to alter the durable current activity state.
 */
export async function importActivityCatalog(
  exportDir: string,
  database: Database,
  snapshotId: number,
  timeZone?: string,
): Promise<CatalogImportSummary> {
  const source = await readFile(join(exportDir, "activities.csv"), "utf8");
  const csv = parseCsv(source);
  const rows = csv.rows.map((values, index) => normalizeActivityCatalogRow(csv.headers, values, index + 2));
  const now = new Date().toISOString();
  let inserted = 0; let changed = 0; let unchanged = 0; let invalid = 0;

  const importRows = database.transaction(() => {
    database.prepare("INSERT OR REPLACE INTO catalog_column_maps (snapshot_id, source_path, map_version, columns_json) VALUES (?, 'activities.csv', ?, ?)")
      .run(snapshotId, ACTIVITY_CATALOG_COLUMN_MAP_VERSION, JSON.stringify(buildPositionalColumnMap(csv.headers)));
    const insertRow = database.prepare(`
      INSERT INTO activity_catalog_rows (snapshot_id, activity_id, row_number, row_hash, column_map_version, raw_values_json, parsed_values_json, parse_status, parse_error_summary, observed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const existing = database.prepare("SELECT catalog_row_hash, catalog_map_version FROM activities WHERE id = ?");
    const insertActivity = database.prepare(`
      INSERT INTO activities (id, catalog_filename, sport_type, started_at, duration_seconds, distance_meters, available, catalog_row_hash, catalog_map_version, first_seen_snapshot_id, last_seen_snapshot_id, last_observed_at, observation_status, name, description, moving_seconds, distance_miles, elevation_gain_meters, average_heart_rate, average_watts, relative_effort, training_load, intensity, commute)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateActivity = database.prepare(`
      UPDATE activities SET catalog_filename = ?, sport_type = ?, started_at = ?, duration_seconds = ?, distance_meters = ?, available = 1, catalog_row_hash = ?, catalog_map_version = ?, last_seen_snapshot_id = ?, last_observed_at = ?, observation_status = 'observed', name = ?, description = ?, moving_seconds = ?, distance_miles = ?, elevation_gain_meters = ?, average_heart_rate = ?, average_watts = ?, relative_effort = ?, training_load = ?, intensity = ?, commute = ?
      WHERE id = ?
    `);
    const observeUnchanged = database.prepare("UPDATE activities SET last_seen_snapshot_id = ?, last_observed_at = ?, observation_status = 'observed' WHERE id = ?");
    const upsertFile = database.prepare(`
      INSERT INTO activity_files (activity_id, relative_path, format, decode_status)
      VALUES (?, ?, ?, 'not-decoded')
      ON CONFLICT(relative_path) DO UPDATE SET activity_id = excluded.activity_id, format = excluded.format
    `);
    const observedIds = new Set<string>();

    for (const row of rows) {
      const activityId = value<string>(row, "activityId");
      const status = parseStatus(row);
      const duplicate = activityId !== null && observedIds.has(activityId);
      const errorSummary = [...row.issues.map((issue) => `${issue.field}: ${issue.message}`), ...(duplicate ? ["activityId: Duplicate Activity ID in catalog."] : [])].join("; ") || null;
      insertRow.run(snapshotId, activityId, row.rowNumber, row.rowHash, ACTIVITY_CATALOG_COLUMN_MAP_VERSION, JSON.stringify(row.rawValues), JSON.stringify(row.parsedValues), duplicate || status === "invalid" ? "invalid" : "valid", errorSummary, now);
      if (activityId === null || status === "invalid" || duplicate) { invalid += 1; continue; }
      observedIds.add(activityId);

      const prior = existing.get(activityId) as { catalog_row_hash: string | null; catalog_map_version: number | null } | undefined;
      if (prior === undefined) {
        insertActivity.run(activityId, value<string>(row, "catalogFilename"), value<string>(row, "sportType"), value<string>(row, "startedAt"), value<number>(row, "elapsedSeconds"), value<number>(row, "distanceMeters"), 1, row.rowHash, ACTIVITY_CATALOG_COLUMN_MAP_VERSION, snapshotId, snapshotId, now, "observed", value<string>(row, "name"), value<string>(row, "description"), value<number>(row, "movingSeconds"), value<number>(row, "distanceMiles"), value<number>(row, "elevationGainMeters"), value<number>(row, "averageHeartRate"), value<number>(row, "averageWatts"), value<number>(row, "relativeEffort"), value<number>(row, "trainingLoad"), value<number>(row, "intensity"), value<boolean>(row, "commute") === null ? null : value<boolean>(row, "commute") ? 1 : 0);
        inserted += 1;
      } else if (prior.catalog_row_hash === row.rowHash && prior.catalog_map_version === ACTIVITY_CATALOG_COLUMN_MAP_VERSION) {
        observeUnchanged.run(snapshotId, now, activityId);
        unchanged += 1;
      } else {
        updateActivity.run(value<string>(row, "catalogFilename"), value<string>(row, "sportType"), value<string>(row, "startedAt"), value<number>(row, "elapsedSeconds"), value<number>(row, "distanceMeters"), row.rowHash, ACTIVITY_CATALOG_COLUMN_MAP_VERSION, snapshotId, now, value<string>(row, "name"), value<string>(row, "description"), value<number>(row, "movingSeconds"), value<number>(row, "distanceMiles"), value<number>(row, "elevationGainMeters"), value<number>(row, "averageHeartRate"), value<number>(row, "averageWatts"), value<number>(row, "relativeEffort"), value<number>(row, "trainingLoad"), value<number>(row, "intensity"), value<boolean>(row, "commute") === null ? null : value<boolean>(row, "commute") ? 1 : 0, activityId);
        changed += 1;
      }
      const catalogFilename = value<string>(row, "catalogFilename");
      if (catalogFilename !== null) upsertFile.run(activityId, catalogFilename, activityFileFormat(catalogFilename));
    }
    const missing = database.prepare("UPDATE activities SET observation_status = 'no-longer-observed', available = 0 WHERE observation_status = 'observed' AND (last_seen_snapshot_id IS NULL OR last_seen_snapshot_id != ?)").run(snapshotId).changes;
    database.prepare("INSERT OR REPLACE INTO catalog_imports (snapshot_id, imported_at, inserted_count, changed_count, unchanged_count, missing_count, invalid_count) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(snapshotId, now, inserted, changed, unchanged, missing, invalid);
    database.prepare("UPDATE source_manifest SET imported_at = ? WHERE snapshot_id = ? AND relative_path = 'activities.csv'").run(now, snapshotId);
    return missing;
  });
  const noLongerObserved = importRows();
  // Local times derive from the catalog's start time, so they are resolved
  // again whenever that value is imported or corrected.
  const offsetCoverage = resolveActivityLocalTimes(database, timeZone);
  return Object.freeze({ snapshotId, inserted, changed, unchanged, noLongerObserved, invalid, offsetCoverage });
}
