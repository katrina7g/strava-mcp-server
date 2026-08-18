import { cp, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { importActivityCatalog } from "../src/catalog.js";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { closeDatabase, openDatabase, type Database } from "../src/database.js";
import { gearDisplayName, getGear, importGear } from "../src/gear.js";
import { normalizeMatchKey } from "../src/identity.js";
import { createServer } from "../src/server.js";
import { validateExport } from "../src/validator.js";

const temporaryRoots: string[] = [];

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function textContent(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

async function committedFixture(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "strava-mcp-gear-"));
  temporaryRoots.push(root);
  const exportDir = join(root, "export");
  await cp(fileURLToPath(new URL("./fixtures/minimal-export", import.meta.url)), exportDir, { recursive: true });
  return { exportDir, dataDir: join(root, "cache") };
}

async function importAll(paths: { exportDir: string; dataDir: string }): Promise<Database> {
  const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
  const database = await openDatabase(config);
  await validateExport(paths.exportDir, database);
  const snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
  await importActivityCatalog(paths.exportDir, database, snapshot.id);
  await importGear(paths.exportDir, database, snapshot.id);
  return database;
}

describe("Gear identity", () => {
  it("falls back to brand and model when the export leaves the gear name blank", () => {
    // Every shoes.csv row in the reference export has a blank Shoe Name.
    expect(gearDisplayName({ name: null, brand: "Brooks", model: "Revel 3" })).toBe("Brooks Revel 3");
    expect(gearDisplayName({ name: "Race Day", brand: "Brooks", model: "Revel 3" })).toBe("Race Day");
    expect(gearDisplayName({ name: null, brand: null, model: null })).toBeNull();
  });

  it("matches gear names across case and whitespace but keeps punctuation", () => {
    expect(normalizeMatchKey("Saucony  peregrine 8")).toBe(normalizeMatchKey("SAUCONY Peregrine 8"));
    expect(normalizeMatchKey(" Brooks Revel 3 ")).toBe("brooks revel 3");
    // Punctuation distinguishes real models, so it is never stripped.
    expect(normalizeMatchKey("Ghost 15")).not.toBe(normalizeMatchKey("Ghost-15"));
  });
});

describe("Gear import", () => {
  it("links a blank-named gear row to the activities that reference it", async () => {
    const database = await importAll(await committedFixture());
    const result = getGear(database, {}) as { gear: Array<Record<string, unknown>> };
    const trail = result.gear.find((item) => item.name === "Fixture Trail Two");
    closeDatabase(database);

    expect(trail).toMatchObject({ name: "Fixture Trail Two", brand: "Fixture", model: "Trail Two", source: "gear-file", activityCount: 1, distanceMeters: 5000 });
  });

  it("keeps both mismatch directions visible rather than dropping them", async () => {
    const database = await importAll(await committedFixture());
    const result = getGear(database, {}) as { gear: Array<Record<string, unknown>>; dataAvailability: string };
    const retired = result.gear.find((item) => item.name === "Retired Fixture Shoe");
    const unused = result.gear.find((item) => item.name === "Named Fixture Shoe");
    closeDatabase(database);

    // Referenced by an activity but absent from every gear file.
    expect(retired).toMatchObject({ source: "activity-catalog-only", activityCount: 1 });
    // Present in the gear file but never used.
    expect(unused).toMatchObject({ source: "gear-file", activityCount: 0 });
    expect(result.dataAvailability).toContain("inferred from activity references only");
  });

  it("reports an empty gear source without failing", async () => {
    const root = await mkdtemp(join(tmpdir(), "strava-mcp-nogear-"));
    temporaryRoots.push(root);
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\nsolo,Jan 1 2026 10:00:00 AM,Run,Run,600,1,activities/solo.gpx,600,1609,0\n");
    await writeFile(join(exportDir, "activities", "solo.gpx"), "<gpx />");
    const database = await importAll({ exportDir, dataDir: join(root, "cache") });
    const result = getGear(database, {}) as { gear: unknown[]; dataAvailability: string; pagination: { total: number } };
    closeDatabase(database);

    expect(result.gear).toEqual([]);
    expect(result.pagination.total).toBe(0);
    expect(result.dataAvailability).toBe("No gear data was included in this export.");
  });

  it("re-imports idempotently, reporting unchanged rather than duplicating", async () => {
    const paths = await committedFixture();
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    await validateExport(paths.exportDir, database);
    let snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    await importActivityCatalog(paths.exportDir, database, snapshot.id);
    const first = await importGear(paths.exportDir, database, snapshot.id);

    await validateExport(paths.exportDir, database);
    snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
    await importActivityCatalog(paths.exportDir, database, snapshot.id);
    const second = await importGear(paths.exportDir, database, snapshot.id);
    const total = database.prepare("SELECT COUNT(*) AS count FROM gear").get() as { count: number };
    closeDatabase(database);

    expect(first[0]).toMatchObject({ inserted: 3, changed: 0, unchanged: 0 });
    expect(second[0]).toMatchObject({ inserted: 0, changed: 0, unchanged: 3, noLongerObserved: 0 });
    expect(total.count).toBe(3);
  });
});

describe("Gear over MCP", () => {
  it("imports supporting data and serves get_gear with availability reporting", async () => {
    const paths = await committedFixture();
    const config: ServerConfig = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const server = createServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const gear = JSON.parse(textContent(await client.callTool({ name: "get_gear", arguments: { pageSize: 2 } })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_archive_summary", arguments: {} })));
    const schema = JSON.parse(textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "gear" } })));
    await client.close();

    expect(imported.domains[0]).toMatchObject({ domain: "gear", availability: "available", inserted: 3 });
    expect(gear.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, hasMore: true });
    expect(summary.domains.imported).toEqual(expect.arrayContaining([{ domain: "gear", records: 3 }]));
    // Empty gear sources are named, not silently absent.
    expect(summary.domains.availableButEmpty).toEqual(expect.arrayContaining(["bikes.csv", "components.csv"]));
    // A domain with no query tool must not look queryable.
    expect(summary.domains.notImported.map((entry: { domain: string }) => entry.domain)).toEqual(expect.arrayContaining(["media", "social"]));
    expect(schema.gear.queryTool).toBe("get_gear");
  });
});
