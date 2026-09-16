import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-media-"));
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

const CATALOG_HEADER = "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain,Media";

/**
 * Covers every combination the reference export contains: a photo listed in
 * both sources, one only an activity references, one only media.csv lists, and
 * one referenced but absent from disk.
 */
async function mediaExport(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await temporaryDirectory();
  const exportDir = join(root, "export");
  await mkdir(join(exportDir, "media"), { recursive: true });
  await mkdir(join(exportDir, "activities"), { recursive: true });
  const rows = [
    `run-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5,media/both.jpg|media/catalog-only.jpg`,
    `run-2,"Jan 3, 2026, 7:00:00 AM",Two,Run,120,0.1,,110,100,5,media/absent.jpg`,
    `run-3,"Jan 4, 2026, 7:00:00 AM",Three,Run,120,0.1,,110,100,5,`,
  ].join("\n");
  await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\n${rows}\n`);
  await writeFile(join(exportDir, "media.csv"), [
    "Media Filename,Media Caption",
    'media/both.jpg,"A caption"',
    'media/unreferenced.jpg,""',
    'media/absent.jpg,""',
  ].join("\n") + "\n");
  await writeFile(join(exportDir, "media", "both.jpg"), "not a real image");
  await writeFile(join(exportDir, "media", "catalog-only.jpg"), "not a real image");
  await writeFile(join(exportDir, "media", "unreferenced.jpg"), "not a real image");
  return { exportDir, dataDir: join(root, "cache") };
}

describe("Media references", () => {
  it("keeps both mismatch directions and flags a referenced file that is absent", async () => {
    const { exportDir, dataDir } = await mediaExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const all = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: {} })));
    await client.close();

    const byPath = Object.fromEntries((all.media as { relativePath: string }[]).map((item) => [item.relativePath, item]));
    expect(imported.domains.map((domain: { domain: string }) => domain.domain)).toContain("media");
    expect(all.pagination.total).toBe(4);
    // Listed in media.csv and referenced by an activity: caption and link.
    expect(byPath["media/both.jpg"]).toMatchObject({ source: "media-file", caption: "A caption", fileStatus: "present", activityCount: 1 });
    // Referenced by an activity but absent from media.csv: kept, no caption.
    expect(byPath["media/catalog-only.jpg"]).toMatchObject({ source: "activity-catalog-only", caption: null, fileStatus: "present", activityCount: 1 });
    // Listed in media.csv but referenced by nothing: kept, no activity link.
    expect(byPath["media/unreferenced.jpg"]).toMatchObject({ source: "media-file", activityCount: 0 });
    // Referenced and listed, but the file is not in the export.
    expect(byPath["media/absent.jpg"]).toMatchObject({ fileStatus: "missing", activityCount: 1 });
  });

  it("filters by activity, source, and file status", async () => {
    const { exportDir, dataDir } = await mediaExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const forActivity = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: { activityId: "run-1" } })));
    const catalogOnly = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: { source: "activity-catalog-only" } })));
    const missing = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: { fileStatus: "missing" } })));
    const none = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: { activityId: "run-3" } })));
    await client.close();

    expect(forActivity.media.map((item: { relativePath: string }) => item.relativePath)).toEqual(["media/both.jpg", "media/catalog-only.jpg"]);
    expect(forActivity.media[0].activityIds).toEqual(["run-1"]);
    expect(catalogOnly.media).toHaveLength(1);
    expect(missing.media.map((item: { relativePath: string }) => item.relativePath)).toEqual(["media/absent.jpg"]);
    expect(none.media).toEqual([]);
  });

  it("reports an unsafe media reference and never imports it", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "media"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5,../../etc/passwd\n`);
    await writeFile(join(exportDir, "media.csv"), "Media Filename,Media Caption\n");
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    const validation = JSON.parse(textContent(await client.callTool({ name: "validate_export", arguments: {} })));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const listed = JSON.parse(textContent(await client.callTool({ name: "list_media", arguments: {} })));
    await client.close();

    expect(validation.findings.map((finding: { code: string }) => finding.code)).toContain("REFERENCED_PATH_UNSAFE");
    // The reference is counted as invalid rather than stored under any name.
    expect(imported.domains.find((domain: { domain: string }) => domain.domain === "media").invalid).toBe(1);
    expect(listed.media).toEqual([]);
  });

  it("warns when an activity references media that media.csv does not list", async () => {
    const { exportDir, dataDir } = await mediaExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    const validation = JSON.parse(textContent(await client.callTool({ name: "validate_export", arguments: {} })));
    await client.close();

    const unlisted = validation.findings.filter((finding: { code: string }) => finding.code === "MEDIA_REFERENCE_UNLISTED");
    expect(unlisted).toHaveLength(1);
    expect(unlisted[0]).toMatchObject({ severity: "warning", path: "media/catalog-only.jpg" });
  });
});
