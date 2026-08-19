import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { elevationGainMeters } from "../src/elevation.js";
import { simplify, simplifyToLimit, type LonLat } from "../src/geometry.js";
import { createServer } from "../src/server.js";

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

describe("Route simplification by tolerance", () => {
  it("keeps every point when none exceeds the tolerance", () => {
    // A straight line: no interior point deviates from the endpoint segment.
    const line: LonLat[] = Array.from({ length: 20 }, (_, index) => ({ longitude: -122 + index * 0.0001, latitude: 47 }));
    expect(simplify(line, 5)).toEqual([line[0], line[line.length - 1]]);
  });

  it("keeps a point that deviates from the line by more than the tolerance", () => {
    const points: LonLat[] = [
      { longitude: -122, latitude: 47 },
      { longitude: -122, latitude: 47.01 }, // roughly 1.1km off the straight line below
      { longitude: -121.99, latitude: 47 },
    ];
    const result = simplify(points, 5);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(points[0]);
    expect(result[2]).toEqual(points[2]);
  });

  it("always retains the first and last point regardless of tolerance", () => {
    const points: LonLat[] = Array.from({ length: 50 }, (_, index) => ({ longitude: -122 + index * 0.00001, latitude: 47 + index * 0.00001 }));
    const result = simplify(points, 10_000);
    expect(result[0]).toEqual(points[0]);
    expect(result.at(-1)).toEqual(points.at(-1));
  });

  it("doubles the tolerance until the result fits the point cap and reports it", () => {
    // A jagged path so a small tolerance keeps far more than maxPoints.
    const points: LonLat[] = Array.from({ length: 200 }, (_, index) => ({
      longitude: -122 + index * 0.0001,
      latitude: 47 + (index % 2 === 0 ? 0.001 : -0.001),
    }));
    const { points: reduced, toleranceMeters } = simplifyToLimit(points, 10, 1);
    expect(reduced.length).toBeLessThanOrEqual(10);
    expect(toleranceMeters).toBeGreaterThan(1);
  });
});

describe("elevationGainMeters", () => {
  it("absorbs jitter within the noise band and credits a climb past it", () => {
    expect(elevationGainMeters([10, 10.4, 10, 10.4, 20], 1)).toBeCloseTo(10, 9);
  });

  it("does not zero out a gradual climb whose individual steps are all sub-threshold", () => {
    // Every consecutive delta is 0.5m, well under a 1m threshold. A naive
    // per-step gate ("only count a step that alone exceeds the threshold")
    // reports 0 for this whole series — the bug this module replaces.
    // Hysteresis still credits each 1.5m excursion once it clears the
    // baseline, landing on 4.5m; the final 0.5m tail from the last captured
    // baseline (4.5) to the series end (5.0) has not yet cleared the
    // threshold and is legitimately not yet counted.
    const gradual = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0];
    expect(elevationGainMeters(gradual, 1)).toBeCloseTo(4.5, 9);
    expect(elevationGainMeters(gradual, 1)).toBeGreaterThan(0);
  });

  it("ignores null altitude samples rather than treating a gap as a drop", () => {
    expect(elevationGainMeters([10, null, null, 20], 1)).toBeCloseTo(10, 9);
  });

  it("returns null when no sample has an altitude at all", () => {
    expect(elevationGainMeters([null, null], 1)).toBeNull();
  });

  it("counts a climb even when a later equal descent returns to the start", () => {
    // Elevation gain is cumulative ascent, not net displacement: a 10m climb
    // followed by a 10m descent still gained 10m over the course.
    expect(elevationGainMeters([10, 20, 10], 1)).toBeCloseTo(10, 9);
  });
});

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
