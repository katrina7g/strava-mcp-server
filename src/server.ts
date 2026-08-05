import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { loadConfig, type ServerConfig } from "./config.js";

const SERVER_NAME = "strava-mcp-server";
const SERVER_VERSION = "1.0.0";

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
