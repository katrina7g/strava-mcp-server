import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadConfig, type ServerConfig } from "./config.js";
import { closeDatabase, openDatabase } from "./database.js";
import { validateExport } from "./validator.js";

const SERVER_NAME = "strava-mcp-server";
const SERVER_VERSION = "1.0.0";
const MAX_TOOL_FINDINGS = 50;

/**
 * Creates the server without opening a transport, which keeps the entry point
 * usable by future functional tests.
 */
export function createServer(config: ServerConfig = loadConfig()): McpServer {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool(
    "get_server_info",
    {
      title: "Get server information",
      description: "Returns the Strava MCP server identity and current mode.",
    },
    async () => ({
      content: [
        {
          type: "text",
          text: JSON.stringify({
            name: SERVER_NAME,
            version: SERVER_VERSION,
            mode: "local-read-only",
            exportConfigured: config.exportDir !== undefined,
          }),
        },
      ],
    }),
  );

  server.registerTool(
    "validate_export",
    {
      title: "Validate Strava export",
      description: "Read-only validation of the configured local Strava export. Records a local validation snapshot but never changes the export.",
      inputSchema: z.object({}),
    },
    async () => {
      if (config.exportDir === undefined) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify({ code: "EXPORT_DIR_NOT_CONFIGURED", message: "Set STRAVA_EXPORT_DIR before validating an export." }) }],
        };
      }
      const database = await openDatabase(config);
      try {
        const report = await validateExport(config.exportDir, database);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              outcome: report.outcome,
              delta: report.summary,
              findings: report.findings.slice(0, MAX_TOOL_FINDINGS),
              totalFindings: report.findings.length,
              findingsTruncated: report.findings.length > MAX_TOOL_FINDINGS,
            }),
          }],
        };
      } finally {
        closeDatabase(database);
      }
    },
  );

  return server;
}

export async function main(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

const entryPoint = process.argv[1];
const isMainModule =
  entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href;

if (isMainModule) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(`Failed to start ${SERVER_NAME}: ${message}`);
    process.exitCode = 1;
  });
}
