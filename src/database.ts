import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import type { ServerConfig } from "./config.js";

const DATABASE_FILE = "strava.sqlite";
const LATEST_SCHEMA_VERSION = 9;
const SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"];

export type Database = Sqlite.Database;

function applyPrivatePermissions(path: string): Promise<void> {
  // Windows does not have POSIX modes. Failure is non-fatal where chmod is not
  // meaningful, but callers still get a database that was opened locally.
  return chmod(path, 0o600).catch(() => undefined);
}

function applySidecarPermissions(databasePath: string): Promise<void[]> {
  return Promise.all(SIDECAR_SUFFIXES.map((suffix) => applyPrivatePermissions(`${databasePath}${suffix}`)));
}

export async function openDatabase(config: ServerConfig): Promise<Database> {
  // SQLite's rollback-journal/WAL/SHM sidecars are created by the native
  // driver directly, so we cannot chmod them until after they exist. Setting
  // a restrictive umask before any file in this data directory is created
  // closes that window; the process only ever writes here.
  process.umask(0o077);
  await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  await chmod(config.dataDir, 0o700).catch(() => undefined);

  const databasePath = join(config.dataDir, DATABASE_FILE);
  const database = new Sqlite(databasePath);
  database.pragma("foreign_keys = ON");
  await applyPrivatePermissions(databasePath);
  migrate(database);
  await applySidecarPermissions(databasePath);
  return database;
}

function migrate(database: Database): void {
  database.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = database.prepare("SELECT version FROM schema_version LIMIT 1").get() as
    | { version: number }
    | undefined;
  const currentVersion = row?.version ?? 0;
  if (currentVersion > LATEST_SCHEMA_VERSION) {
    throw new Error(`Database schema version ${currentVersion} is newer than this server supports.`);
  }
  if (currentVersion === LATEST_SCHEMA_VERSION) return;

  const transaction = database.transaction(() => {
    if (currentVersion < 1) migrationOne(database);
    if (currentVersion < 2) migrationTwo(database);
    if (currentVersion < 3) migrationThree(database);
    if (currentVersion < 4) migrationFour(database);
    if (currentVersion < 5) migrationFive(database);
    if (currentVersion < 6) migrationSix(database);
    if (currentVersion < 7) migrationSeven(database);
    if (currentVersion < 8) migrationEight(database);
    if (currentVersion < 9) migrationNine(database);
    if (row === undefined) {
      database.prepare("INSERT INTO schema_version (version) VALUES (?)").run(LATEST_SCHEMA_VERSION);
    } else {
      database.prepare("UPDATE schema_version SET version = ?").run(LATEST_SCHEMA_VERSION);
    }
  });
  transaction();
}

function migrationOne(database: Database): void {
  database.exec(`
    CREATE TABLE export_snapshots (
      id INTEGER PRIMARY KEY,
      export_root TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      outcome TEXT NOT NULL,
      new_count INTEGER NOT NULL DEFAULT 0,
      changed_count INTEGER NOT NULL DEFAULT 0,
      unchanged_count INTEGER NOT NULL DEFAULT 0,
      missing_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE source_manifest (
      id INTEGER PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      relative_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      format TEXT,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      status TEXT NOT NULL,
      record_count INTEGER,
      is_empty INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      validated_at TEXT NOT NULL,
      imported_at TEXT,
      UNIQUE(snapshot_id, relative_path)
    );
    CREATE INDEX source_manifest_snapshot_path ON source_manifest(snapshot_id, relative_path);
    CREATE TABLE activities (
      id TEXT PRIMARY KEY,
      catalog_filename TEXT,
      sport_type TEXT,
      started_at TEXT,
      duration_seconds REAL,
      distance_meters REAL,
      available INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE activity_files (
      id INTEGER PRIMARY KEY,
      activity_id TEXT REFERENCES activities(id),
      relative_path TEXT NOT NULL UNIQUE,
      format TEXT NOT NULL,
      sha256 TEXT,
      decode_status TEXT,
      parse_error TEXT
    );
  `);
}

function migrationTwo(database: Database): void {
  database.exec(`
    CREATE TABLE findings (
      id INTEGER PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      path TEXT,
      message TEXT NOT NULL
    );
    CREATE INDEX findings_snapshot ON findings(snapshot_id);
  `);
}

/** Allows a source observed during traversal to be recorded even when reading
 * it fails before a checksum or reliable size can be obtained. */
function migrationThree(database: Database): void {
  database.exec(`
    CREATE TABLE source_manifest_next (
      id INTEGER PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      relative_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      format TEXT,
      size_bytes INTEGER,
      sha256 TEXT,
      status TEXT NOT NULL,
      record_count INTEGER,
      is_empty INTEGER NOT NULL DEFAULT 0,
      error_summary TEXT,
      validated_at TEXT NOT NULL,
      imported_at TEXT,
      UNIQUE(snapshot_id, relative_path)
    );
    INSERT INTO source_manifest_next
      SELECT id, snapshot_id, relative_path, source_kind, format, size_bytes,
        sha256, status, record_count, is_empty, error_summary, validated_at,
        imported_at
      FROM source_manifest;
    DROP TABLE source_manifest;
    ALTER TABLE source_manifest_next RENAME TO source_manifest;
    CREATE INDEX source_manifest_snapshot_path ON source_manifest(snapshot_id, relative_path);
  `);
}

/** Catalog records will be imported in the next phase. These tables retain
 * every parsed source row and the durable, current activity state separately. */
function migrationFour(database: Database): void {
  database.exec(`
    ALTER TABLE activities ADD COLUMN catalog_row_hash TEXT;
    ALTER TABLE activities ADD COLUMN catalog_map_version INTEGER;
    ALTER TABLE activities ADD COLUMN first_seen_snapshot_id INTEGER REFERENCES export_snapshots(id);
    ALTER TABLE activities ADD COLUMN last_seen_snapshot_id INTEGER REFERENCES export_snapshots(id);
    ALTER TABLE activities ADD COLUMN last_observed_at TEXT;
    ALTER TABLE activities ADD COLUMN observation_status TEXT NOT NULL DEFAULT 'observed';

    CREATE TABLE activity_catalog_rows (
      id INTEGER PRIMARY KEY,
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      activity_id TEXT,
      row_number INTEGER NOT NULL,
      row_hash TEXT NOT NULL,
      column_map_version INTEGER NOT NULL,
      raw_values_json TEXT NOT NULL,
      parsed_values_json TEXT NOT NULL,
      parse_status TEXT NOT NULL,
      parse_error_summary TEXT,
      observed_at TEXT NOT NULL,
      UNIQUE(snapshot_id, row_number)
    );
    CREATE INDEX activity_catalog_rows_snapshot_activity
      ON activity_catalog_rows(snapshot_id, activity_id);
    CREATE INDEX activities_last_seen_snapshot
      ON activities(last_seen_snapshot_id);
  `);
}

function migrationFive(database: Database): void {
  database.exec(`
    ALTER TABLE activities ADD COLUMN name TEXT;
    ALTER TABLE activities ADD COLUMN description TEXT;
    ALTER TABLE activities ADD COLUMN moving_seconds REAL;
    ALTER TABLE activities ADD COLUMN distance_miles REAL;
    ALTER TABLE activities ADD COLUMN elevation_gain_meters REAL;
    ALTER TABLE activities ADD COLUMN average_heart_rate REAL;
    ALTER TABLE activities ADD COLUMN average_watts REAL;
    ALTER TABLE activities ADD COLUMN relative_effort REAL;
    ALTER TABLE activities ADD COLUMN commute INTEGER;

    CREATE INDEX activities_search ON activities(observation_status, sport_type, started_at);
    CREATE TABLE catalog_column_maps (
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      source_path TEXT NOT NULL,
      map_version INTEGER NOT NULL,
      columns_json TEXT NOT NULL,
      PRIMARY KEY(snapshot_id, source_path)
    );
    CREATE TABLE catalog_imports (
      snapshot_id INTEGER PRIMARY KEY REFERENCES export_snapshots(id),
      imported_at TEXT NOT NULL,
      inserted_count INTEGER NOT NULL,
      changed_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL,
      missing_count INTEGER NOT NULL,
      invalid_count INTEGER NOT NULL
    );
  `);
}

function migrationSix(database: Database): void {
  database.exec(`
    ALTER TABLE activities ADD COLUMN training_load REAL;
    ALTER TABLE activities ADD COLUMN intensity REAL;
    CREATE INDEX activities_training_load ON activities(observation_status, training_load);
  `);
}

function migrationSeven(database: Database): void {
  database.exec(`
    CREATE TABLE activity_streams (
      id INTEGER PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES activities(id),
      sequence INTEGER NOT NULL,
      timestamp TEXT,
      latitude REAL,
      longitude REAL,
      altitude_meters REAL,
      distance_meters REAL,
      heart_rate REAL,
      cadence REAL,
      power_watts REAL,
      speed_meters_per_second REAL,
      source_payload_json TEXT,
      UNIQUE(activity_id, sequence)
    );
    CREATE INDEX activity_streams_window ON activity_streams(activity_id, timestamp, distance_meters);
    CREATE TABLE activity_laps (
      id INTEGER PRIMARY KEY,
      activity_id TEXT NOT NULL REFERENCES activities(id),
      sequence INTEGER NOT NULL,
      started_at TEXT,
      duration_seconds REAL,
      distance_meters REAL,
      elevation_gain_meters REAL,
      average_heart_rate REAL,
      average_cadence REAL,
      average_power_watts REAL,
      source_payload_json TEXT,
      UNIQUE(activity_id, sequence)
    );
    CREATE TABLE activity_bounds (
      activity_id TEXT PRIMARY KEY REFERENCES activities(id),
      point_count INTEGER NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      min_latitude REAL,
      min_longitude REAL,
      max_latitude REAL,
      max_longitude REAL,
      total_distance_meters REAL,
      elevation_gain_meters REAL,
      has_location INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX activity_files_decode ON activity_files(decode_status);
  `);
}

/** Export timestamps are UTC, but training questions are asked in local time.
 * The per-file offset is a fact about one decoded FIT file; the activity-level
 * offset is the resolved value, which records which source produced it. */
function migrationEight(database: Database): void {
  database.exec(`
    ALTER TABLE activity_files ADD COLUMN utc_offset_minutes INTEGER;
    ALTER TABLE activities ADD COLUMN started_at_local TEXT;
    ALTER TABLE activities ADD COLUMN utc_offset_minutes INTEGER;
    ALTER TABLE activities ADD COLUMN offset_source TEXT;
    CREATE INDEX activities_local_time
      ON activities(observation_status, sport_type, started_at_local);
  `);
}

/** Supporting domains keep current state only: a row hash plus observation
 * columns give the same delta reporting as the catalog without a per-snapshot
 * raw-row table, which earns its cost on the 103-column catalog and not here.
 * Gear identity is a normalized name because the export has no gear ID. */
function migrationNine(database: Database): void {
  database.exec(`
    CREATE TABLE gear (
      id TEXT PRIMARY KEY,
      gear_type TEXT NOT NULL,
      display_name TEXT NOT NULL,
      match_key TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      default_sport_types TEXT,
      source TEXT NOT NULL,
      row_hash TEXT,
      first_seen_snapshot_id INTEGER REFERENCES export_snapshots(id),
      last_seen_snapshot_id INTEGER REFERENCES export_snapshots(id),
      observation_status TEXT NOT NULL DEFAULT 'observed'
    );
    CREATE INDEX gear_match ON gear(match_key);

    ALTER TABLE activities ADD COLUMN gear_name TEXT;
    ALTER TABLE activities ADD COLUMN gear_match_key TEXT;
    CREATE INDEX activities_gear ON activities(observation_status, gear_match_key);

    CREATE TABLE supporting_imports (
      snapshot_id INTEGER NOT NULL REFERENCES export_snapshots(id),
      domain TEXT NOT NULL,
      source_path TEXT NOT NULL,
      availability TEXT NOT NULL,
      imported_at TEXT NOT NULL,
      inserted_count INTEGER NOT NULL,
      changed_count INTEGER NOT NULL,
      unchanged_count INTEGER NOT NULL,
      missing_count INTEGER NOT NULL,
      invalid_count INTEGER NOT NULL,
      PRIMARY KEY (snapshot_id, source_path)
    );
  `);
}

export function closeDatabase(database: Database): void {
  database.close();
}
