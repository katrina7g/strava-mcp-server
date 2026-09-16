import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { elevationGainMeters } from "../../src/elevation.js";
import { simplify, simplifyToLimit, type LonLat } from "../../src/geometry.js";
import { createServer } from "../../src/server.js";

const temporaryRoots: string[] = [];

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-cleanup-"));
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

const CATALOG_HEADER = "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain";

describe("Elevation gain smoothing", () => {
  it("ignores sub-threshold jitter but still counts a real climb", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\njitter-1,"Jan 2, 2026, 7:00:00 AM",Jitter,Run,120,0.1,activities/jitter-1.gpx,110,100,5\n`);
    // Four points oscillating within the 1m noise band around a baseline of
    // 10.0m, then one genuine 10m climb to 20.0m.
    const points = [
      { ele: 10.0, t: "2026-01-02T15:00:00Z" },
      { ele: 10.4, t: "2026-01-02T15:00:10Z" },
      { ele: 10.0, t: "2026-01-02T15:00:20Z" },
      { ele: 10.4, t: "2026-01-02T15:00:30Z" },
      { ele: 20.0, t: "2026-01-02T15:00:40Z" },
    ];
    const trkpts = points.map((p) => `<trkpt lat="37.1" lon="-122.1"><ele>${p.ele}</ele><time>${p.t}</time></trkpt>`).join("");
    await writeFile(join(exportDir, "activities", "jitter-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg>${trkpts}</trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const activity = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "jitter-1" } })));
    await client.close();

    // Raw summation of every positive delta would report 0.4+0.4+10.0 = 10.8m;
    // smoothing counts only the step that clears the threshold, 10.0m.
    expect(activity.telemetry.elevationGainMeters).toBeCloseTo(10, 9);
  });

  it("labels device-derived elevation gain as distinct from the catalog's own figure", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ngpx-1,"Jan 2, 2026, 7:00:00 AM",GPX,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><ele>10</ele><time>2026-01-02T15:00:00Z</time></trkpt><trkpt lat="37.1" lon="-122.1"><ele>20</ele><time>2026-01-02T15:00:10Z</time></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const activity = JSON.parse(textContent(await client.callTool({ name: "get_activity", arguments: { activityId: "gpx-1" } })));
    const route = JSON.parse(textContent(await client.callTool({ name: "get_activity_route", arguments: { activityId: "gpx-1", includeLocation: true } })));
    await client.close();

    expect(activity.limitations.join(" ")).toContain("not Strava's own corrected figure");
    expect(activity.limitations.join(" ")).toContain("can diverge");
    expect(route.definitions.elevationGainMeters).toContain("noise smoothing");
  });
});

describe("Nesting-aware XML matching", () => {
  it("reads GPX heart rate nested under a device's TrackPointExtension wrapper", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nwrapped-1,"Jan 2, 2026, 7:00:00 AM",Wrapped,Run,120,0.1,activities/wrapped-1.gpx,110,100,5\n`);
    // Matches the real export's structure: extensions -> TrackPointExtension -> hr.
    await writeFile(join(exportDir, "activities", "wrapped-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><ele>10</ele><time>2026-01-02T15:00:00Z</time><extensions><gpxtpx:TrackPointExtension xmlns:gpxtpx="x"><gpxtpx:hr>165</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "wrapped-1", fields: ["heartRate"] } })));
    await client.close();

    expect(stream.points[0]).toMatchObject({ heartRate: 165 });
  });

  it("does not mistake a same-named element outside any extension for telemetry", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ndecoy-1,"Jan 2, 2026, 7:00:00 AM",Decoy,Run,120,0.1,activities/decoy-1.gpx,110,100,5\n`);
    // <hr> appears as a direct trkpt child, outside any <extensions> block.
    await writeFile(join(exportDir, "activities", "decoy-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><ele>10</ele><time>2026-01-02T15:00:00Z</time><hr>999</hr></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "decoy-1", fields: ["heartRate"] } })));
    await client.close();

    expect(stream.points[0]).toMatchObject({ heartRate: null });
  });

  it("reads TCX heart rate only from a Value under HeartRateBpm, not a same-named sibling", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ntcx-decoy,"Jan 2, 2026, 7:00:00 AM",TCX,Run,120,0.1,activities/tcx-decoy.tcx.gz,110,100,5\n`);
    // A SensorState extension also carrying a <Value>, alongside the real HeartRateBpm one.
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity><Lap StartTime="2026-01-02T15:00:00Z"><TotalTimeSeconds>60</TotalTimeSeconds><Track><Trackpoint><Time>2026-01-02T15:00:00Z</Time><HeartRateBpm><Value>150</Value></HeartRateBpm><Extensions><TPX><SensorState><Value>1</Value></SensorState></TPX></Extensions></Trackpoint></Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    await writeFile(join(exportDir, "activities", "tcx-decoy.tcx.gz"), gzipSync(tcx));
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_detailed_activities", arguments: {} });
    const stream = JSON.parse(textContent(await client.callTool({ name: "get_activity_stream", arguments: { activityId: "tcx-decoy", fields: ["heartRate"] } })));
    await client.close();

    expect(stream.points[0]).toMatchObject({ heartRate: 150 });
  });
});

describe("Detailed import only decodes currently-observed files", () => {
  it("skips a linked file the latest snapshot no longer reports", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\ngpx-1,"Jan 2, 2026, 7:00:00 AM",GPX,Run,120,0.1,activities/gpx-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "gpx-1.gpx"), `<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="37.1" lon="-122.1"><time>2026-01-02T15:00:00Z</time></trkpt></trkseg></trk></gpx>`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    // The source file is removed after the catalog links it, and a fresh
    // validation snapshot is recorded without it — this is what a stale
    // activity_files row looks like once an export changes between visits.
    await rm(join(exportDir, "activities", "gpx-1.gpx"));
    await client.callTool({ name: "validate_export", arguments: {} });

    const imported = JSON.parse(textContent(await client.callTool({ name: "import_detailed_activities", arguments: {} })));
    await client.close();

    expect(imported).toMatchObject({ decoded: 0, skipped: 1 });
  });
});

describe("Single-snapshot catalog import", () => {
  it("reuses the latest validation snapshot instead of validating again", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",Run,Run,120,0.1,activities/run-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "run-1.gpx"), "<gpx />");
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));

    await client.callTool({ name: "validate_export", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_activity_catalog", arguments: {} })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_archive_summary", arguments: {} })));
    await client.close();

    // One snapshot from validate_export, reused by the import that followed —
    // not a second one recorded for the same intent.
    expect(imported.snapshotId).toBe(1);
    expect(summary.latestSnapshot.id).toBe(1);
  });

  it("records a fresh snapshot when revalidate is explicitly requested", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",Run,Run,120,0.1,activities/run-1.gpx,110,100,5\n`);
    await writeFile(join(exportDir, "activities", "run-1.gpx"), "<gpx />");
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));

    await client.callTool({ name: "validate_export", arguments: {} });
    const first = JSON.parse(textContent(await client.callTool({ name: "import_activity_catalog", arguments: {} })));
    const second = JSON.parse(textContent(await client.callTool({ name: "import_activity_catalog", arguments: { revalidate: true } })));
    await client.close();

    expect(second.snapshotId).toBeGreaterThan(first.snapshotId);
  });
});
