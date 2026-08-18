import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder } from "@garmin/fitsdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { importActivityCatalog } from "../src/catalog.js";
import { ConfigError, loadConfig, type ServerConfig } from "../src/config.js";
import { closeDatabase, openDatabase, type Database } from "../src/database.js";
import { importDetailedActivityFiles } from "../src/details.js";
import { fitOffsetMinutes, offsetMinutesForZone } from "../src/localtime.js";
import { createServer } from "../src/server.js";
import { validateExport } from "../src/validator.js";

const FIT_EPOCH_SECONDS = 631_065_600;
const temporaryRoots: string[] = [];

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function textContent(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

/** A minimal but genuine FIT file whose activity message states a local
 * offset, so the adapter is exercised without committing exported data. */
function syntheticFit(utc: Date, offsetMinutes: number): Uint8Array {
  const encoder = new Encoder();
  encoder.writeMesg({ mesgNum: 0, type: "activity", manufacturer: "garmin", product: 1, timeCreated: utc, serialNumber: 1 });
  encoder.writeMesg({
    mesgNum: 34,
    timestamp: utc,
    localTimestamp: (utc.valueOf() + offsetMinutes * 60_000) / 1000 - FIT_EPOCH_SECONDS,
    numSessions: 1, type: "manual", event: "activity", eventType: "stop",
  });
  return encoder.close();
}

type Fixture = { exportDir: string; dataDir: string };

async function exportFixture(rows: string, files: Record<string, string | Uint8Array>): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "strava-mcp-localtime-"));
  temporaryRoots.push(root);
  const exportDir = join(root, "export");
  await mkdir(join(exportDir, "activities"), { recursive: true });
  await writeFile(join(exportDir, "activities.csv"), `Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n${rows}\n`);
  for (const [name, contents] of Object.entries(files)) await writeFile(join(exportDir, "activities", name), contents);
  return { exportDir, dataDir: join(root, "cache") };
}

async function importAll(fixture: Fixture, config: ServerConfig): Promise<Database> {
  const database = await openDatabase(config);
  await validateExport(fixture.exportDir, database);
  const snapshot = database.prepare("SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1").get() as { id: number };
  await importActivityCatalog(fixture.exportDir, database, snapshot.id, config.timeZone);
  await importDetailedActivityFiles(fixture.exportDir, database, undefined, config.timeZone);
  return database;
}

describe("UTC offset derivation", () => {
  it("derives a FIT offset from its local and UTC timestamps", () => {
    const utc = new Date("2026-03-27T01:28:59Z");
    const local = (utc.valueOf() - 7 * 3_600_000) / 1000 - FIT_EPOCH_SECONDS;

    expect(fitOffsetMinutes({ timestamp: utc, localTimestamp: local })).toBe(-420);
    expect(fitOffsetMinutes({ timestamp: utc, localTimestamp: new Date(utc.valueOf() + 5.5 * 3_600_000) })).toBe(330);
    expect(fitOffsetMinutes({ timestamp: utc })).toBeNull();
    expect(fitOffsetMinutes(undefined)).toBeNull();
    // Beyond any real zone, so the value is treated as unusable rather than trusted.
    expect(fitOffsetMinutes({ timestamp: utc, localTimestamp: local + 86_400 })).toBeNull();
  });

  it("derives a configured zone's offset across daylight saving and partial-hour zones", () => {
    expect(offsetMinutesForZone(new Date("2025-01-15T12:00:00Z"), "America/Los_Angeles")).toBe(-480);
    expect(offsetMinutesForZone(new Date("2025-07-15T12:00:00Z"), "America/Los_Angeles")).toBe(-420);
    expect(offsetMinutesForZone(new Date("2025-07-15T12:00:00Z"), "Asia/Kathmandu")).toBe(345);
    expect(offsetMinutesForZone(new Date("2025-07-15T12:00:00Z"), "Not/AZone")).toBeNull();
  });

  it("rejects a configured time zone that is not an IANA name", () => {
    expect(() => loadConfig({ STRAVA_MCP_DATA_DIR: "/tmp/strava-mcp-zone", STRAVA_MCP_TIMEZONE: "Pacific Time" })).toThrow(ConfigError);
    expect(loadConfig({ STRAVA_MCP_DATA_DIR: "/tmp/strava-mcp-zone", STRAVA_MCP_TIMEZONE: "America/Los_Angeles" }).timeZone).toBe("America/Los_Angeles");
  });
});

describe("Activity local time resolution", () => {
  it("prefers a decoded FIT offset over the configured zone", async () => {
    const fixture = await exportFixture(
      "fit-1,\"Mar 27, 2026, 1:28:59 AM\",Night Run,Run,3600,6.2,activities/fit-1.fit,3500,10000,120",
      { "fit-1.fit": syntheticFit(new Date("2026-03-27T01:28:59Z"), -420) },
    );
    const config = loadConfig({ STRAVA_EXPORT_DIR: fixture.exportDir, STRAVA_MCP_DATA_DIR: fixture.dataDir, STRAVA_MCP_TIMEZONE: "Europe/Berlin" });
    const database = await importAll(fixture, config);
    const activity = database.prepare("SELECT started_at AS startedAt, started_at_local AS startedAtLocal, utc_offset_minutes AS offset, offset_source AS source FROM activities WHERE id = 'fit-1'").get();
    closeDatabase(database);

    expect(activity).toEqual({
      startedAt: "2026-03-27T01:28:59.000Z",
      startedAtLocal: "2026-03-26T18:28:59",
      offset: -420,
      source: "fit-local-timestamp",
    });
  });

  it("falls back to the configured zone when a source carries no offset", async () => {
    const fixture = await exportFixture(
      "gpx-1,\"Mar 27, 2026, 1:28:59 AM\",Night Run,Run,3600,6.2,activities/gpx-1.gpx,3500,10000,120",
      { "gpx-1.gpx": "<?xml version=\"1.0\"?><gpx version=\"1.1\"><trk><trkseg><trkpt lat=\"37.77\" lon=\"-122.41\"><ele>10</ele><time>2026-03-27T01:28:59Z</time></trkpt></trkseg></trk></gpx>" },
    );
    const config = loadConfig({ STRAVA_EXPORT_DIR: fixture.exportDir, STRAVA_MCP_DATA_DIR: fixture.dataDir, STRAVA_MCP_TIMEZONE: "America/Los_Angeles" });
    const database = await importAll(fixture, config);
    const activity = database.prepare("SELECT started_at_local AS startedAtLocal, utc_offset_minutes AS offset, offset_source AS source FROM activities WHERE id = 'gpx-1'").get();
    closeDatabase(database);

    expect(activity).toEqual({ startedAtLocal: "2026-03-26T18:28:59", offset: -420, source: "configured-zone" });
  });

  it("reports no offset and groups in UTC when no source supplies one", async () => {
    const fixture = await exportFixture(
      "gpx-1,\"Mar 27, 2026, 1:28:59 AM\",Night Run,Run,3600,6.2,activities/gpx-1.gpx,3500,10000,120",
      { "gpx-1.gpx": "<gpx />" },
    );
    const config = loadConfig({ STRAVA_EXPORT_DIR: fixture.exportDir, STRAVA_MCP_DATA_DIR: fixture.dataDir });
    const database = await importAll(fixture, config);
    const activity = database.prepare("SELECT started_at_local AS startedAtLocal, utc_offset_minutes AS offset, offset_source AS source FROM activities WHERE id = 'gpx-1'").get();
    closeDatabase(database);

    expect(activity).toEqual({ startedAtLocal: "2026-03-27T01:28:59", offset: null, source: "none" });
  });
});

describe("Time basis in grouped results", () => {
  it("groups an evening activity by its local day rather than its UTC day", async () => {
    const fixture = await exportFixture(
      "fit-1,\"Mar 27, 2026, 1:28:59 AM\",Night Run,Run,3600,6.2,activities/fit-1.fit,3500,10000,120",
      { "fit-1.fit": syntheticFit(new Date("2026-03-27T01:28:59Z"), -420) },
    );
    const config = loadConfig({ STRAVA_EXPORT_DIR: fixture.exportDir, STRAVA_MCP_DATA_DIR: fixture.dataDir });
    const server = createServer(config);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });

    const local = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "day", metrics: ["activityCount"] } })));
    const utc = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "day", metrics: ["activityCount"], timeBasis: "utc" } })));
    await client.close();

    expect(local.groups).toEqual([{ period: "2026-03-26", activityCount: 1 }]);
    expect(local.timeBasis).toBe("local");
    expect(local.offsetCoverage).toMatchObject({ "fit-local-timestamp": 1 });
    expect(utc.groups).toEqual([{ period: "2026-03-27", activityCount: 1 }]);
  });
});
