import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_CATALOG_COLUMN_MAP_VERSION, buildPositionalColumnMap, normalizeActivityCatalogRow } from "../src/catalog.js";
import { importActivityCatalog } from "../src/catalog.js";
import { loadConfig } from "../src/config.js";
import { closeDatabase, openDatabase } from "../src/database.js";
import { validateExport } from "../src/validator.js";

const temporaryRoots: string[] = [];
async function fixture(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "strava-mcp-catalog-")); temporaryRoots.push(root);
  const exportDir = join(root, "export"); const dataDir = join(root, "cache");
  await mkdir(join(exportDir, "activities"), { recursive: true });
  await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain,Average Heart Rate,Average Watts,Relative Effort,Commute\n1,Jan 1 2026 10:00:00 AM,Morning Run,Run,3600,6.2,activities/1.gpx,3500,10000,120,150,250,40,false\n2,Feb 1 2026 10:00:00 AM,Ride,Ride,7200,12.4,activities/2.fit,7000,20000,300,140,190,60,false\n");
  await writeFile(join(exportDir, "activities", "1.gpx"), "<gpx />");
  await writeFile(join(exportDir, "activities", "2.fit"), "synthetic");
  return { exportDir, dataDir };
}

async function committedFixture(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "strava-mcp-committed-fixture-")); temporaryRoots.push(root);
  const exportDir = join(root, "export");
  await cp(fileURLToPath(new URL("./fixtures/minimal-export", import.meta.url)), exportDir, { recursive: true });
  return { exportDir, dataDir: join(root, "cache") };
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("activity catalog normalization", () => {
  const headers = ["Activity ID", "Activity Date", "Distance", "Distance", "Filename", "Commute"];

  it("preserves duplicate headers positionally and parses canonical fields", () => {
    const map = buildPositionalColumnMap(headers);
    const row = normalizeActivityCatalogRow(headers, ["42", "Jul 8, 2026, 1:05:36 AM", "12.68", "20414.8", "activities/42.fit.gz", "false"], 2);

    expect(ACTIVITY_CATALOG_COLUMN_MAP_VERSION).toBe(1);
    expect(map.map((column) => column.internalName)).toEqual(["activity_id", "activity_date", "distance", "distance__2", "filename", "commute"]);
    expect(row.rawValues).toMatchObject({ distance: "12.68", distance__2: "20414.8" });
    expect(row.parsedValues).toMatchObject({ activityId: "42", distanceMiles: 12.68, distanceMeters: 20414.8, catalogFilename: "activities/42.fit.gz", commute: false });
    expect(row.issues).toEqual([]);
  });

  it("retains raw values and reports typed and required-field failures", () => {
    const row = normalizeActivityCatalogRow(headers, ["", "not a date", "x", "", "", "perhaps"], 7);

    expect(row.rawValues).toMatchObject({ activity_id: "", activity_date: "not a date", distance: "x", commute: "perhaps" });
    expect(row.parsedValues.activityId).toBeNull();
    expect(row.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["CATALOG_REQUIRED_FIELD_MISSING", "CATALOG_VALUE_INVALID"]));
  });

  it("uses a stable hash that changes with any positional source value", () => {
    const first = normalizeActivityCatalogRow(headers, ["42", "", "1", "1609.34", "activities/42.gpx", "false"], 2);
    const same = normalizeActivityCatalogRow(headers, ["42", "", "1", "1609.34", "activities/42.gpx", "false"], 3);
    const changed = normalizeActivityCatalogRow(headers, ["42", "", "2", "3218.68", "activities/42.gpx", "false"], 2);

    expect(first.rowHash).toBe(same.rowHash);
    expect(changed.rowHash).not.toBe(first.rowHash);
  });

  it("imports new, unchanged, changed, and no-longer-observed activity state", async () => {
    const paths = await fixture(); const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    await validateExport(paths.exportDir, database);
    let snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(await importActivityCatalog(paths.exportDir, database, snapshot.id)).toMatchObject({ inserted: 2, changed: 0, unchanged: 0, noLongerObserved: 0, invalid: 0 });

    await validateExport(paths.exportDir, database);
    snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(await importActivityCatalog(paths.exportDir, database, snapshot.id)).toMatchObject({ inserted: 0, changed: 0, unchanged: 2, noLongerObserved: 0 });

    await writeFile(join(paths.exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain,Average Heart Rate,Average Watts,Relative Effort,Commute\n1,Jan 1 2026 10:00:00 AM,Long Run,Run,4000,7,activities/1.gpx,3900,11265,130,151,251,45,false\n");
    await validateExport(paths.exportDir, database);
    snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    expect(await importActivityCatalog(paths.exportDir, database, snapshot.id)).toMatchObject({ inserted: 0, changed: 1, unchanged: 0, noLongerObserved: 1 });
    const activities = database.prepare("SELECT id, name, observation_status AS observationStatus FROM activities ORDER BY id").all();
    const activityFile = database.prepare("SELECT activity_id AS activityId, relative_path AS relativePath, format FROM activity_files WHERE activity_id = '1'").get();
    closeDatabase(database);
    expect(activities).toEqual([{ id: "1", name: "Long Run", observationStatus: "observed" }, { id: "2", name: "Ride", observationStatus: "no-longer-observed" }]);
    expect(activityFile).toEqual({ activityId: "1", relativePath: "activities/1.gpx", format: "gpx" });
  });

  it("imports the committed minimal fixture with empty optional sources", async () => {
    const paths = await committedFixture(); const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    const validation = await validateExport(paths.exportDir, database);
    const snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    const imported = await importActivityCatalog(paths.exportDir, database, snapshot.id);
    closeDatabase(database);

    expect(validation.availability).toMatchObject({ "media.csv": "available-but-empty" });
    expect(imported).toMatchObject({ inserted: 2, invalid: 0 });
  });
});
