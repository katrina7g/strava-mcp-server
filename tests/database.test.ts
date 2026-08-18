import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { closeDatabase, openDatabase } from "../src/database.js";

const temporaryRoots: string[] = [];
async function temporaryDataDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-database-"));
  temporaryRoots.push(directory);
  return join(directory, "cache");
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Database initialization", () => {
  it("initializes and reopens the same store without error or data loss", async () => {
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    const first = await openDatabase(config);
    first.prepare("INSERT INTO export_snapshots (export_root, started_at, completed_at, outcome) VALUES (?, ?, ?, ?)").run("/export", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "completed");
    closeDatabase(first);

    const second = await openDatabase(config);
    const version = second.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    const snapshots = second.prepare("SELECT count(*) AS count FROM export_snapshots").get() as { count: number };
    closeDatabase(second);

    expect(version.version).toBe(9);
    expect(snapshots.count).toBe(1);
  });

  it("is a no-op when the schema is already current", async () => {
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    const first = await openDatabase(config);
    closeDatabase(first);

    // migrationOne/migrationTwo use CREATE TABLE without IF NOT EXISTS, so a
    // second run against an already-current schema would throw on a real
    // (non-idempotent) migration path.
    await expect(openDatabase(config)).resolves.toBeTruthy();
  });

  it("refuses to open a database with a newer schema version than it supports", async () => {
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    const seed = await openDatabase(config);
    closeDatabase(seed);

    const raw = new Sqlite(join(dataDir, "strava.sqlite"));
    raw.prepare("UPDATE schema_version SET version = ?").run(99);
    raw.close();

    await expect(openDatabase(config)).rejects.toThrow(/newer than this server supports/);
  });

  it("restricts data directory and database file creation to the owner", async () => {
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    const database = await openDatabase(config);
    closeDatabase(database);

    if (process.platform === "win32") return;
    const databaseMode = (await stat(join(dataDir, "strava.sqlite"))).mode & 0o777;
    const dataDirMode = (await stat(dataDir)).mode & 0o777;
    expect(databaseMode).toBe(0o600);
    expect(dataDirMode).toBe(0o700);
    expect(process.umask()).toBe(0o077);
  });

  it("creates catalog provenance and incremental activity-state schema", async () => {
    const dataDir = await temporaryDataDir();
    const database = await openDatabase(loadConfig({ STRAVA_MCP_DATA_DIR: dataDir }));
    const catalogColumns = database.prepare("PRAGMA table_info(activity_catalog_rows)").all() as { name: string }[];
    const activityColumns = database.prepare("PRAGMA table_info(activities)").all() as { name: string }[];
    closeDatabase(database);

    expect(catalogColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["snapshot_id", "activity_id", "row_hash", "column_map_version", "raw_values_json", "parsed_values_json", "parse_status"]));
    expect(activityColumns.map((column) => column.name)).toEqual(expect.arrayContaining(["catalog_row_hash", "first_seen_snapshot_id", "last_seen_snapshot_id", "observation_status"]));
  });
});
