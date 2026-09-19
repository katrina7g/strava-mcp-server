import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-community-"));
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

/**
 * Covers the shapes an export produces: global challenges present, group
 * challenges and clubs headers-only, and memberships naming a club that has
 * no club record.
 */
async function communityExport(): Promise<{ exportDir: string; dataDir: string }> {
  const root = await temporaryDirectory();
  const exportDir = join(root, "export");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(exportDir, { recursive: true });
  await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5\n`);
  await writeFile(join(exportDir, "global_challenges.csv"), [
    "Join Date,Name,Completed",
    '"Feb 3, 2026, 9:15:00 AM",Coastal Trail Series,true',
    '"Jan 9, 2026, 8:00:00 AM",Winter Base Builder,false',
  ].join("\n") + "\n");
  // Headers but no rows, which is available-but-empty rather than an error.
  await writeFile(join(exportDir, "group_challenges.csv"), "Join Date,Name,Completed\n");
  await writeFile(join(exportDir, "clubs.csv"), "Club Name,Club Description,Club Type,Club Sport,City,Country,State,Club Website,Cover Photo,Club Picture\n");
  await writeFile(join(exportDir, "memberships.csv"), [
    "Join Date,Club Name",
    '"Feb 14, 2019, 12:00:00 PM",Lunch Runners',
  ].join("\n") + "\n");
  return { exportDir, dataDir: join(root, "cache") };
}

describe("Challenges, clubs and memberships", () => {
  it("imports challenges and reports completion and scope", async () => {
    const { exportDir, dataDir } = await communityExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const all = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: {} })));
    const completed = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: { completed: true } })));
    const group = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: { scope: "group" } })));
    await client.close();

    expect(all.pagination.total).toBe(2);
    expect(all.challenges[0]).toMatchObject({ scope: "global", name: "Coastal Trail Series", completed: true });
    // The export's date format is parsed to a real instant, not kept as text.
    expect(all.challenges[0].joinedAt).toBe("2026-02-03T09:15:00.000Z");
    expect(completed.challenges.map((row: { name: string }) => row.name)).toEqual(["Coastal Trail Series"]);
    // An empty source yields no rows without failing the call.
    expect(group.challenges).toEqual([]);
  });

  it("keeps both joins of a recurring challenge with the same name", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5\n`);
    // A recurring challenge joined in two different years under one name.
    // Keying by name alone would drop a row.
    await writeFile(join(exportDir, "global_challenges.csv"), [
      "Join Date,Name,Completed",
      '"Apr 2, 2026, 7:30:00 AM",Riverside Ten,false',
      '"Nov 6, 2026, 7:30:00 AM",Riverside Ten,true',
    ].join("\n") + "\n");
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const challenges = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: {} })));
    await client.close();

    const delta = imported.domains.find((domain: { domain: string }) => domain.domain === "challenges");
    expect(delta).toMatchObject({ inserted: 2, changed: 0 });
    expect(challenges.pagination.total).toBe(2);
    expect(challenges.challenges.map((row: { completed: boolean }) => row.completed)).toEqual([true, false]);
  });

  it("keeps a membership whose club has no club record", async () => {
    const { exportDir, dataDir } = await communityExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const clubs = JSON.parse(textContent(await client.callTool({ name: "get_clubs", arguments: {} })));
    await client.close();

    const clubDelta = imported.domains.find((domain: { domain: string }) => domain.domain === "clubs");
    // clubs.csv is empty and memberships.csv is not, so the domain is
    // available overall and the club is known by name alone.
    expect(clubDelta.availability).toBe("available");
    expect(clubs.pagination.total).toBe(1);
    expect(clubs.clubs[0]).toMatchObject({ name: "Lunch Runners", source: "membership-only", isMember: true, description: null });
    expect(clubs.clubs[0].joinedAt).toBe("2019-02-14T12:00:00.000Z");
  });

  it("reports an entirely absent domain as unavailable without failing", async () => {
    const root = await temporaryDirectory();
    const exportDir = join(root, "export");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(exportDir, { recursive: true });
    await writeFile(join(exportDir, "activities.csv"), `${CATALOG_HEADER}\nrun-1,"Jan 2, 2026, 7:00:00 AM",One,Run,120,0.1,,110,100,5\n`);
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: join(root, "cache") }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    const imported = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const challenges = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: {} })));
    await client.close();

    const byDomain = Object.fromEntries(imported.domains.map((domain: { domain: string }) => [domain.domain, domain]));
    expect(byDomain.challenges.availability).toBe("unavailable");
    expect(byDomain.clubs.availability).toBe("unavailable");
    expect(challenges.challenges).toEqual([]);
  });

  it("re-imports without duplicating rows", async () => {
    const { exportDir, dataDir } = await communityExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    await client.callTool({ name: "import_activity_catalog", arguments: {} });
    await client.callTool({ name: "import_supporting_data", arguments: {} });
    const second = JSON.parse(textContent(await client.callTool({ name: "import_supporting_data", arguments: {} })));
    const challenges = JSON.parse(textContent(await client.callTool({ name: "get_challenges", arguments: {} })));
    await client.close();

    const byDomain = Object.fromEntries(second.domains.map((domain: { domain: string }) => [domain.domain, domain]));
    expect(challenges.pagination.total).toBe(2);
    expect(byDomain.challenges).toMatchObject({ inserted: 0, changed: 0, unchanged: 2, noLongerObserved: 0 });
  });

  it("publishes both domains through the data schema", async () => {
    const { exportDir, dataDir } = await communityExport();
    const client = await connectedClient(loadConfig({ STRAVA_EXPORT_DIR: exportDir, STRAVA_MCP_DATA_DIR: dataDir }));
    const challenges = JSON.parse(textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "challenges" } })));
    const clubs = JSON.parse(textContent(await client.callTool({ name: "get_data_schema", arguments: { domain: "clubs" } })));
    await client.close();

    expect(challenges.challenges).toMatchObject({ currentState: "challenges", queryTool: "get_challenges" });
    expect(clubs.clubs).toMatchObject({ currentState: "clubs", memberships: "club_memberships", queryTool: "get_clubs" });
  });
});
