import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("creates an unconnected local read-only server", () => {
    const server = createServer(
      loadConfig({ STRAVA_MCP_DATA_DIR: "/tmp/strava-mcp-server-test-cache" }),
    );

    expect(server.isConnected()).toBe(false);
  });
});

const temporaryRoots: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-server-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

function textContent(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return content[0]!.text;
}

async function connectedClient(config: ServerConfig): Promise<{ server: McpServer; client: Client }> {
  const server = createServer(config);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

describe("MCP server tool surface", () => {
  it("serves get_server_info over a real MCP transport", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "get_server_info", arguments: {} });
    const payload = JSON.parse(textContent(result));
    expect(payload).toMatchObject({ name: "strava-mcp-server", mode: "local-read-only", exportConfigured: false });
    await client.close();
  });

  it("runs validate_export over a real MCP transport and returns a structured report", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Filename\n1,activities/run.gpx\n");
    await writeFile(join(exportDir, "activities", "run.gpx"), "<gpx />");
    const config = loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(textContent(result));
    expect(payload.outcome).toBe("completed");
    expect(payload.delta).toEqual({ new: 2, changed: 0, unchanged: 0, noLongerObserved: 0 });
    await client.close();
  });

  it("returns a functional error over MCP when no export is configured", async () => {
    const root = await temporaryDirectory();
    const config = loadConfig({ STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(textContent(result));
    expect(payload.code).toBe("EXPORT_DIR_NOT_CONFIGURED");
    await client.close();
  });

  it("bounds MCP findings while preserving the total count", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(exportDir, { recursive: true });
    const rows = Array.from({ length: 60 }, (_, index) => `${index},activities/missing-${index}.gpx`).join("\n");
    await writeFile(join(exportDir, "activities.csv"), `Activity ID,Filename\n${rows}\n`);
    const config = loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") });
    const { client } = await connectedClient(config);

    const result = await client.callTool({ name: "validate_export", arguments: {} });
    const payload = JSON.parse(textContent(result));
    expect(payload.findings).toHaveLength(50);
    expect(payload.totalFindings).toBe(60);
    expect(payload.findingsTruncated).toBe(true);
    await client.close();
  });

  it("imports a catalog and serves archive, schema, search, and aggregate tools", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), "Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n1,Jan 1 2026 10:00:00 AM,Morning Run,Run,3600,6.2,activities/1.gpx,3500,10000,120\n2,Feb 1 2026 10:00:00 AM,Bike Ride,Ride,7200,12.4,activities/2.fit,7000,20000,300\n");
    await writeFile(join(exportDir, "activities", "1.gpx"), "<gpx />"); await writeFile(join(exportDir, "activities", "2.fit"), "fit");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_activity_catalog", arguments: {} })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_archive_summary", arguments: {} })));
    const schema = JSON.parse(textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "activities" } })));
    const searched = JSON.parse(textContent(await client.callTool({ name: "search_activities", arguments: { sports: ["Run"], text: "Morning" } })));
    const aggregated = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "sport", metrics: ["activityCount", "distanceMeters"] } })));
    expect(imported.catalogDelta).toMatchObject({ inserted: 2 });
    expect(summary.overview.activityCount).toBe(2);
    expect(schema.activities.fields.some((field: { name: string }) => field.name === "distanceMeters")).toBe(true);
    expect(searched.activities).toHaveLength(1);
    expect(aggregated.groups).toEqual(expect.arrayContaining([expect.objectContaining({ period: "Run", activityCount: 1, distanceMeters: 10000 })]));
    await client.close();
  });

  it("paginates safely and represents unavailable metrics as null", async () => {
    const root = await temporaryDirectory(); const exportDir = join(root, "export");
    await mkdir(join(exportDir, "activities"), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, index) => `${index + 1},Jan ${index + 1} 2026 10:00:00 AM,Run ${index + 1},Run,1800,3,activities/${index + 1}.gpx,1700,4828,10`).join("\n");
    await writeFile(join(exportDir, "activities.csv"), `Activity ID,Activity Date,Activity Name,Activity Type,Elapsed Time,Distance,Filename,Moving Time,Distance,Elevation Gain\n${rows}\n`);
    for (const index of [1, 2, 3]) await writeFile(join(exportDir, "activities", `${index}.gpx`), "<gpx />");
    const { client } = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const firstPage = JSON.parse(textContent(await client.callTool({ name: "search_activities", arguments: { page: 1, pageSize: 2, sortDirection: "asc" } })));
    const aggregate = JSON.parse(textContent(await client.callTool({ name: "aggregate_training", arguments: { groupBy: "sport", metrics: ["averageWatts", "averageHeartRate"] } })));
    expect(firstPage.activities).toHaveLength(2);
    expect(firstPage.pagination).toMatchObject({ page: 1, pageSize: 2, total: 3, hasMore: true });
    expect(aggregate.groups).toEqual([{ period: "Run", averageWatts: null, averageHeartRate: null }]);
    await client.close();
  });
});
