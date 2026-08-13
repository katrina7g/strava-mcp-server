import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import type { ServerConfig } from "./config.js";

const DATABASE_FILE = "strava.sqlite";
const LATEST_SCHEMA_VERSION = 3;
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

export function closeDatabase(database: Database): void {
  database.close();
}
