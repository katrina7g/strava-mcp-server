/**
 * Every tool answers with the same envelope so a client can branch on a stable
 * code rather than parse prose. Internal detail — filesystem paths, SQLite
 * messages, stack traces — goes to stderr and never into a response: it can
 * name files inside a private export, and stdout carries the JSON-RPC channel.
 */
export type ToolErrorCode =
  | "EXPORT_DIR_NOT_CONFIGURED"
  | "DATABASE_UNAVAILABLE"
  | "EXPORT_UNREADABLE"
  | "INTERNAL_ERROR";

export type ToolResult = {
  content: [{ type: "text"; text: string }];
  isError?: true;
};

export function toolSuccess(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

export function toolFailure(code: ToolErrorCode, message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ code, message }) }] };
}

export function logInternalError(context: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(`[strava-mcp] ${context}: ${detail}`);
}

/**
 * Runs a tool body so that no exception escapes to the transport. A thrown
 * error would otherwise surface to the client as a protocol failure carrying
 * the raw message.
 */
export async function guardTool(context: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (error) {
    logInternalError(context, error);
    return toolFailure("INTERNAL_ERROR", "The request could not be completed. The server log records the cause.");
  }
}
