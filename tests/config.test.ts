import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("uses a cache directory outside the repository by default", () => {
    const config = loadConfig({});

    expect(config.dataDir).toBe(resolve(homedir(), ".strava-mcp-server"));
    expect(config.exportDir).toBeUndefined();
  });

  it("resolves explicitly configured local paths", () => {
    const config = loadConfig({
      STRAVA_EXPORT_DIR: "/tmp/strava-export",
      STRAVA_MCP_DATA_DIR: "/tmp/strava-cache",
    });

    expect(config).toEqual({
      dataDir: "/tmp/strava-cache",
      exportDir: "/tmp/strava-export",
    });
  });

  it("rejects a cache directory that overlaps the immutable export", () => {
    expect(() =>
      loadConfig({
        STRAVA_EXPORT_DIR: "/tmp/strava-export",
        STRAVA_MCP_DATA_DIR: "/tmp/strava-export/cache",
      }),
    ).toThrow(ConfigError);
  });
});
