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
});
