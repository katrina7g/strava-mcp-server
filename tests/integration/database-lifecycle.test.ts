import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { closeDatabase, openDatabase } from "../../src/database.js";

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

    expect(version.version).toBe(16);
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

  it("prepares a data directory once instead of on every connection", async () => {
    if (process.platform === "win32") return;
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    const first = await openDatabase(config);
    closeDatabase(first);

    // Opening a connection must not reach back into process-wide state. The
    // umask is restored afterwards so neighbouring tests see their own value.
    const original = process.umask(0o022);
    try {
      const second = await openDatabase(config);
      closeDatabase(second);
      expect(process.umask()).toBe(0o022);
    } finally { process.umask(original); }
  });

  it("carries stream and bounds rows through the distance-provenance rebuild", async () => {
    const dataDir = await temporaryDataDir();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: dataDir });

    // Seed at the pre-provenance version so the upgrade path runs for real:
    // version ten adds the column, version eleven rebuilds both tables.
    const seed = await openDatabase(config);
    seed.prepare("INSERT INTO activities (id, sport_type, started_at) VALUES ('fit-1', 'Run', '2026-01-01T00:00:00.000Z')").run();
    seed.prepare("INSERT INTO activities (id, sport_type, started_at) VALUES ('gpx-1', 'Run', '2026-01-02T00:00:00.000Z')").run();
    const point = seed.prepare("INSERT INTO activity_streams (activity_id, sequence, timestamp, latitude, longitude, distance_meters) VALUES (?, ?, ?, ?, ?, ?)");
    point.run("fit-1", 0, "2026-01-01T00:00:00.000Z", 37.1, -122.1, 0);
    point.run("fit-1", 1, "2026-01-01T00:01:00.000Z", 37.2, -122.2, 250);
    point.run("gpx-1", 0, "2026-01-02T00:00:00.000Z", 37.1, -122.1, null);
    point.run("gpx-1", 1, "2026-01-02T00:01:00.000Z", 37.2, -122.2, null);
    const bound = seed.prepare("INSERT INTO activity_bounds (activity_id, point_count, total_distance_meters, has_location, updated_at) VALUES (?, ?, ?, 1, '2026-01-01T00:00:00.000Z')");
    bound.run("fit-1", 2, 250); bound.run("gpx-1", 2, null);
    // Reshape to the version-nine layout rather than restating its DDL, so
    // this test cannot drift from the schema the migrations actually build.
    seed.exec(`
      ALTER TABLE activity_streams DROP COLUMN distance_source;
      ALTER TABLE activity_bounds DROP COLUMN distance_source;
      ALTER TABLE activity_files DROP COLUMN decoded_sha256;
      ALTER TABLE activity_files DROP COLUMN decoder_version;
      ALTER TABLE activity_files DROP COLUMN distance_derivation_version;
      ALTER TABLE activity_files DROP COLUMN decoded_at;
      ALTER TABLE activity_files DROP COLUMN split_derivation_version;
      ALTER TABLE activities DROP COLUMN media_refs;
      DROP TABLE activity_distance_diagnostics;
      DROP TABLE activity_splits;
      DROP TABLE activity_media;
      DROP TABLE media;
      DROP TABLE club_memberships;
      DROP TABLE clubs;
      DROP TABLE challenges;
      DROP TABLE social_counts;
    `);
    seed.prepare("UPDATE schema_version SET version = 9").run();
    closeDatabase(seed);

    const upgraded = await openDatabase(config);
    const version = upgraded.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    const streams = upgraded.prepare("SELECT activity_id AS activityId, sequence, distance_meters AS distanceMeters, distance_source AS distanceSource FROM activity_streams ORDER BY activity_id, sequence").all();
    const bounds = upgraded.prepare("SELECT activity_id AS activityId, total_distance_meters AS totalDistanceMeters, distance_source AS distanceSource FROM activity_bounds ORDER BY activity_id").all();
    const indexes = (upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('activity_streams', 'activity_bounds')").all() as { name: string }[]).map((row) => row.name);
    const foreignKeyViolations = upgraded.pragma("foreign_key_check") as unknown[];
    closeDatabase(upgraded);

    expect(version.version).toBe(16);
    // No row is dropped by the rebuild, and a distance the decoder supplied
    // before provenance existed keeps both its value and its label.
    expect(streams).toEqual([
      { activityId: "fit-1", sequence: 0, distanceMeters: 0, distanceSource: "supplied" },
      { activityId: "fit-1", sequence: 1, distanceMeters: 250, distanceSource: "supplied" },
      { activityId: "gpx-1", sequence: 0, distanceMeters: null, distanceSource: "none" },
      { activityId: "gpx-1", sequence: 1, distanceMeters: null, distanceSource: "none" },
    ]);
    expect(bounds).toEqual([
      { activityId: "fit-1", totalDistanceMeters: 250, distanceSource: "supplied" },
      { activityId: "gpx-1", totalDistanceMeters: null, distanceSource: "none" },
    ]);
    expect(indexes).toEqual(expect.arrayContaining(["activity_streams_window", "sqlite_autoindex_activity_streams_1", "sqlite_autoindex_activity_bounds_1"]));
    expect(foreignKeyViolations).toEqual([]);
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
