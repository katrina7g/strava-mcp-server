import { cp, mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { Encoder } from "@garmin/fitsdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const temporaryRoots: string[] = [];

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-functional-"));
  temporaryRoots.push(directory);
  return directory;
}

function textContent(result: unknown): string {
  return (result as { content: Array<{ text: string }> }).content[0]!.text;
}

async function connectedClient(config: ServerConfig): Promise<Client> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function copiedFixture(name: string): Promise<{ exportDir: string; dataDir: string }> {
  const root = await temporaryDirectory();
  const exportDir = join(root, "export");
  await cp(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), exportDir, { recursive: true });
  return { exportDir, dataDir: join(root, "cache") };
}

/** A genuine FIT activity built at test time, so no binary blob is committed. */
function syntheticFit(utc: Date): Uint8Array {
  const encoder = new Encoder();
  encoder.writeMesg({ mesgNum: 0, type: "activity", manufacturer: "garmin", product: 1, timeCreated: utc, serialNumber: 1 });
  encoder.writeMesg({ mesgNum: 20, timestamp: utc, positionLat: 450000000, positionLong: -1460000000, distance: 0, heartRate: 120, altitude: 10 });
  encoder.writeMesg({ mesgNum: 20, timestamp: new Date(utc.valueOf() + 60_000), positionLat: 450001000, positionLong: -1460001000, distance: 200, heartRate: 140, altitude: 15 });
  encoder.writeMesg({ mesgNum: 19, timestamp: new Date(utc.valueOf() + 60_000), startTime: utc, totalTimerTime: 60, totalDistance: 200, avgHeartRate: 130 });
  encoder.writeMesg({ mesgNum: 34, timestamp: utc, localTimestamp: utc.valueOf() / 1000 - 631_065_600, numSessions: 1, type: "manual", event: "activity", eventType: "stop" });
  return encoder.close();
}

const CATALOG_HEADER = "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain";

describe("Malformed export handling", () => {
  it("reports every defect in one pass without abandoning the valid rows", async () => {
    const paths = await copiedFixture("malformed-export");
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir }));
    const report = JSON.parse(textContent(await client.callTool({ name: "validate_export", arguments: {} })));
    const codes = new Set(report.findings.map((finding: { code: string }) => finding.code));
    await client.close();

    expect(report.outcome).toBe("completed-with-errors");
    expect(codes).toContain("CSV_DUPLICATE_HEADERS");
    expect(codes).toContain("CSV_ROW_WIDTH_INVALID");
    expect(codes).toContain("REFERENCED_FILE_MISSING");
    expect(codes).toContain("REFERENCED_PATH_UNSAFE");
    expect(codes).toContain("GZIP_UNREADABLE");
    // Findings are structural only; no filesystem detail escapes.
    expect(JSON.stringify(report)).not.toContain(paths.exportDir);
  });

  it("reports a missing activity catalog rather than failing", async () => {
    const paths = await copiedFixture("malformed-export");
    await unlink(join(paths.exportDir, "activities.csv"));
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir }));
    const report = JSON.parse(textContent(await client.callTool({ name: "validate_export", arguments: {} })));
    await client.close();

    expect(report.findings.map((finding: { code: string }) => finding.code)).toContain("ACTIVITIES_CATALOG_MISSING");
  });
});

describe("Detailed import resilience", () => {
  it("decodes every supported format and isolates a per-file failure", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    const rows = [
      `gpx-1,"Jan 2, 2026, 7:00:00 AM",GPX,Run,120,0.1,activities/gpx-1.gpx,110,100,5`,
      `fit-1,"Jan 3, 2026, 7:00:00 AM",FIT,Run,120,0.1,activities/fit-1.fit,110,200,5`,
      `fitgz-1,"Jan 4, 2026, 7:00:00 AM",FITGZ,Run,120,0.1,activities/fitgz-1.fit.gz,110,200,5`,
      `tcxgz-1,"Jan 5, 2026, 7:00:00 AM",TCXGZ,Run,120,0.1,activities/tcxgz-1.tcx.gz,110,100,5`,
      `broken-1,"Jan 6, 2026, 7:00:00 AM",BROKEN,Run,120,0.1,activities/broken-1.fit,110,100,5`,
    ].join("\n");
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\n${rows}\n`);
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><ele>10</ele><time>2026-01-02T15:00:00Z</time></trkpt></trkseg></trk></gpx>`);
    const fit = syntheticFit(new Date("2026-01-03T15:00:00Z"));
    await writeFile(join(exportDir, "activities", "fit-1.fit"), fit);
    await writeFile(join(exportDir, "activities", "fitgz-1.fit.gz"), gzipSync(fit));
    // Leading whitespace before the XML declaration, as the real export has.
    await writeFile(join(exportDir, "activities", "tcxgz-1.tcx.gz"), gzipSync(` \n<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity><Lap StartTime="2026-01-05T15:00:00Z"><TotalTimeSeconds>60</TotalTimeSeconds><DistanceMeters>100</DistanceMeters><Track><Trackpoint><Time>2026-01-05T15:00:00Z</Time><AltitudeMeters>10</AltitudeMeters><HeartRateBpm><Value>130</Value></HeartRateBpm></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`));
    await writeFile(join(exportDir, "activities", "broken-1.fit"), "this is not a FIT file");

    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_detailed_activities", arguments: {} })));
    const byId = Object.fromEntries(imported.results.map((result: { activityId: string }) => [result.activityId, result]));
    await client.close();

    // One unreadable file must not stop the other four.
    expect(imported).toMatchObject({ decoded: 4, failed: 1 });
    // Point and lap counts, not just "decoded", so an adapter that silently
    // yields nothing cannot pass.
    expect(byId["gpx-1"]).toMatchObject({ status: "decoded", pointCount: 1, lapCount: 0 });
    expect(byId["fit-1"]).toMatchObject({ status: "decoded", pointCount: 2, lapCount: 1 });
    expect(byId["fitgz-1"]).toMatchObject({ status: "decoded", pointCount: 2, lapCount: 1 });
    expect(byId["tcxgz-1"]).toMatchObject({ status: "decoded", pointCount: 1, lapCount: 1 });
    expect(byId["broken-1"]).toMatchObject({ status: "failed" });
    // The failure is reported without the decoder's raw message.
    expect(byId["broken-1"].error).toBe("Detailed file could not be decoded");
  });

  it("re-imports detailed files without duplicating stream points", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ngpx-1,"Jan 2, 2026, 7:00:00 AM",GPX,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><time>2026-01-02T15:00:00Z</time></trkpt><trkpt lat="37.2" lon="-122.2"><time>2026-01-02T15:01:00Z</time></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "gpx-1" } })));
    await client.close();

    expect(stream.totalPoints).toBe(2);
  });
});

describe("Missing telemetry", () => {
  it("distinguishes an activity with no decoded telemetry from one with none available", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nno-telemetry,"Jan 2, 2026, 7:00:00 AM",Treadmill,Run,1800,3.1,activities/no-telemetry.gpx,1750,5000,0\n`);
    // A structurally valid GPX carrying no trackpoints at all, as four files in
    // the reference export do.
    await writeFile(join(exportDir, "activities", "no-telemetry.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });

    const beforeDecode = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "no-telemetry" } })));
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const afterDecode = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "no-telemetry" } })));
    const route = JSON.parse(textContent(await client.callTool({ name: "get_activity_route", arguments: { activityId: "no-telemetry" } })));
    const analysis = JSON.parse(textContent(await client.callTool({ name: "analyze_activity", arguments: { activityId: "no-telemetry" } })));
    await client.close();

    expect(beforeDecode.telemetry).toMatchObject({ imported: false });
    // Decoded, but the file held nothing: zero points is a fact, not a failure.
    expect(afterDecode.telemetry).toMatchObject({ imported: true, pointCount: 0, hasLocation: false });
    expect(afterDecode.derived).toMatchObject({ totalDistanceSource: "catalog", totalDistanceMeters: 5000 });
    expect(route).toMatchObject({ available: true, summary: { pointCount: 0 } });
    expect(analysis.found).toBe(true);
  });
});

describe("Privacy defaults across the tool surface", () => {
  it("returns no coordinate anywhere without an explicit per-request opt-in", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ngpx-1,"Jan 2, 2026, 7:00:00 AM",GPX,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="47.637626" lon="-122.349686"><ele>10</ele><time>2026-01-02T15:00:00Z</time></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });

    const defaults: Record<string, Record<string, unknown>> = {
      get_activity: { activityId: "gpx-1" },
      get_activity_stream: { activityId: "gpx-1" },
      get_activity_route: { activityId: "gpx-1" },
      search_activities: {},
      aggregate_training: {},
      get_archive_summary: {},
      get_data_schema: {},
      list_sports: {},
      analyze_activity: { activityId: "gpx-1" },
      get_gear: {},
    };
    const leaked: string[] = [];
    for (const [name, args] of Object.entries(defaults)) {
      const body = textContent(await client.callTool({ name, arguments: args }));
      if (body.includes("47.637626") || body.includes("-122.349686")) leaked.push(name);
    }
    // Only an explicit opt-in produces coordinates.
    const opted = textContent(await client.callTool({ name: "get_activity_route", arguments: { activityId: "gpx-1", includeLocation: true } }));
    await client.close();

    expect(leaked).toEqual([]);
    expect(opted).toContain("47.637626");
  });
});
