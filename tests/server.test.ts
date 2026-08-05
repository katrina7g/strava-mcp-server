import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

describe("createServer", () => {
  it("creates an unconnected local read-only server", () => {
    const server = createServer(
      loadConfig({ STRAVA_MCP_DATA_DIR: "/tmp/strava-mcp-server-test-cache" }),
    );

    expect(server.isConnected()).toBe(false);
  });
});
