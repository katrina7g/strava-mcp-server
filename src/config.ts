import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  STRAVA_EXPORT_DIR: z.string().trim().min(1).optional(),
  STRAVA_MCP_DATA_DIR: z.string().trim().min(1).optional(),
  STRAVA_MCP_TIMEZONE: z.string().trim().min(1).optional(),
});

/** An IANA zone name, validated by the runtime rather than a bundled list. */
function isSupportedTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export type ServerConfig = Readonly<{
  /** The immutable source export. It is optional until import support is added. */
  exportDir?: string;
  /** The writable, generated local cache. It must never overlap the export. */
  dataDir: string;
  /** Fallback zone for activities whose source carries no UTC offset. */
  timeZone?: string;
}>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function resolveLocalPath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith(`~${sep}`)) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

function isSameOrNestedPath(candidate: string, parent: string): boolean {
  const pathDifference = relative(parent, candidate);
  return (
    pathDifference === "" ||
    (!pathDifference.startsWith(`..${sep}`) && pathDifference !== ".." && !isAbsolute(pathDifference))
  );
}

function pathsOverlap(firstPath: string, secondPath: string): boolean {
  return (
    isSameOrNestedPath(firstPath, secondPath) ||
    isSameOrNestedPath(secondPath, firstPath)
  );
}

/**
 * Resolves local paths without reading or writing the source export. The cache
 * defaults to a hidden directory under the user's home directory so it remains
 * outside the repository and the export unless explicitly configured otherwise.
 */
export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = environmentSchema.safeParse(environment);

  if (!parsed.success) {
    throw new ConfigError(
      `Invalid Strava MCP configuration: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const exportDir = parsed.data.STRAVA_EXPORT_DIR
    ? resolveLocalPath(parsed.data.STRAVA_EXPORT_DIR)
    : undefined;
  const dataDir = parsed.data.STRAVA_MCP_DATA_DIR
    ? resolveLocalPath(parsed.data.STRAVA_MCP_DATA_DIR)
    : resolve(homedir(), ".strava-mcp-server");

  if (exportDir !== undefined && pathsOverlap(exportDir, dataDir)) {
    throw new ConfigError(
      "STRAVA_MCP_DATA_DIR must not be the export directory or a parent/child of STRAVA_EXPORT_DIR.",
    );
  }

  const timeZone = parsed.data.STRAVA_MCP_TIMEZONE;
  if (timeZone !== undefined && !isSupportedTimeZone(timeZone)) {
    throw new ConfigError(
      `STRAVA_MCP_TIMEZONE must be an IANA time zone name such as America/Los_Angeles; received "${timeZone}".`,
    );
  }

  return Object.freeze({
    ...(exportDir === undefined ? {} : { exportDir }),
    dataDir,
    ...(timeZone === undefined ? {} : { timeZone }),
  });
}

/** Creates only the generated cache directory; it never writes to the export. */
export async function ensureDataDirectory(config: ServerConfig): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
}
