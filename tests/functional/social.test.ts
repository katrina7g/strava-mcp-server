import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Sqlite from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, type ServerConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

const temporaryRoots: string[] = [];
afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-social-"));
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

/** Identifiers and comment text here are deliberately distinctive, so a leak
 * anywhere in the database or a response is unmistakable. */
const FOLLOWER_ID = "999888777";
const FOLLOWING_ID = "111222333";
const PARENT_ACTIVITY_ID = "555444333";
const COMMENT_TEXT = "SECRET-COMMENT-BODY";

async function socialExport(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await temporaryDirectory();
  const exportDir = join(root, "export");
  await mkdir(exportDir, { recursive: true });
  await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5\n`);
  await writeFile(join(exportDir, "followers.csv"), [
    "Follower Athlete ID,Follow Status,Favorite Status",
    `${FOLLOWER_ID},Accepted,""`,
    '123123123,Pending,""',
  ].join("\n") + "\n");
  await writeFile(join(exportDir, "following.csv"), [
    "Following Athlete ID,Follow Status,Favorite Status",
    `${FOLLOWING_ID},Accepted,Boost Activities in Feed`,
  ].join("\n") + "\n");
  await writeFile(join(exportDir, "reactions.csv"), [
    "Reaction Date,Reaction Type,Parent Type,Parent ID",
    `"Mar 4, 2021, 10:00:00 AM",Kudos,Activity,${PARENT_ACTIVITY_ID}`,
    '"Mar 5, 2021, 11:00:00 AM",Kudos,Activity,222333444',
    '"Apr 1, 2021, 9:00:00 AM",Kudos,Post,333444555',
  ].join("\n") + "\n");
  await writeFile(join(exportDir, "comments.csv"), [
    "Comment Date,Comment",
    `"Jun 10, 2022, 1:00:00 PM",${COMMENT_TEXT}`,
  ].join("\n") + "\n");
  return { exportDir, dataDir: join(root, "cache") };
}

describe("Social summary", () => {
  it("reports outbound counts grouped by type, parent type, and month", async () => {
    const { exportDir, dataDir } = await socialExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_social_summary", arguments: {} })));
    await client.close();

    expect(summary.available).toBe(true);
    expect(summary.followers).toMatchObject({ total: 2, followStatus: { Accepted: 1, Pending: 1 } });
    expect(summary.following).toMatchObject({ total: 1, favoriteStatus: { "Boost Activities in Feed": 1 } });
    expect(summary.reactions).toMatchObject({ total: 3, reactionType: { Kudos: 3 }, parentType: { Activity: 2, Post: 1 } });
    expect(summary.reactions.month).toEqual({ "2021-03": 2, "2021-04": 1 });
    expect(summary.comments).toEqual({ total: 1, month: { "2022-06": 1 } });
  });

  it("stores no third-party identifier and no comment text anywhere", async () => {
    const { exportDir, dataDir } = await socialExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const summary = textContent(await client.callTool({ name: "get_social_summary", arguments: {} }));
    const schema = textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "social" } }));
    await client.close();

    const secrets = [FOLLOWER_ID, FOLLOWING_ID, PARENT_ACTIVITY_ID, COMMENT_TEXT];
    for (const secret of secrets) {
      expect(summary).not.toContain(secret);
      expect(schema).not.toContain(secret);
    }

    // The guarantee is about the database, not only the response: a value that
    // was never stored cannot be leaked by a later tool or by the file itself.
    const raw = new Sqlite(join(dataDir, "strava.sqlite"), { readonly: true });
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name);
    const found: string[] = [];
    for (const table of tables) {
      const columns = (raw.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
      for (const row of raw.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[]) {
        for (const column of columns) {
          const value = row[column];
          if (typeof value === "string" && secrets.some((secret) => value.includes(secret))) found.push(`${table}.${column}`);
        }
      }
    }
    raw.close();
    expect(found).toEqual([]);
  });

  it("states that inbound kudos and comments cannot be derived", async () => {
    const { exportDir, dataDir } = await socialExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_social_summary", arguments: {} })));
    await client.close();

    expect(summary.limitations.join(" ")).toContain("received");
    expect(summary.definitions.scope).toContain("outbound");
  });

  it("reports an absent social domain without failing", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5\n`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const summary = JSON.parse(textContent(await client.callTool({ name: "get_social_summary", arguments: {} })));
    await client.close();

    const social = imported.domains.find((domain: { domain: string }) => domain.domain === "social");
    expect(social.availability).toBe("unavailable");
    // Counts still exist, all zero, so the domain is queryable rather than an error.
    expect(summary).toMatchObject({ available: true, followers: { total: 0 }, comments: { total: 0 } });
  });
});
