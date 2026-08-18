import { createHash } from "node:crypto";
import { createReadStream, type Dirent } from "node:fs";
import { access, realpath, readdir, readFile, stat } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { basename, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Database } from "./database.js";
import { logInternalError } from "./errors.js";

export type Finding = { code: string; severity: "warning" | "error"; path?: string; message: string };
export type ManifestEntry = { relativePath: string; sourceKind: string; format: string | null; sizeBytes: number | null; sha256: string | null; status: "new" | "changed" | "unchanged" | "read-failed"; recordCount: number | null; isEmpty: boolean; errorSummary: string | null };
export type ValidationReport = { outcome: "completed" | "completed-with-errors"; summary: { new: number; changed: number; unchanged: number; noLongerObserved: number }; findings: Finding[]; sources: ManifestEntry[]; availability: Record<string, "available" | "available-but-empty" | "unavailable"> };

const REQUIRED_CATALOG = "activities.csv";
const OPTIONAL_DIRECTORIES = new Set(["activities", "media", "clubs", "routes"]);

function within(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}

async function safeRoot(exportDir: string): Promise<string> {
  const source = await realpath(exportDir);
  const sourceStats = await stat(source);
  if (!sourceStats.isDirectory()) throw new Error("STRAVA_EXPORT_DIR is not a directory.");
  await access(source);
  return source;
}

async function filesUnder(root: string, directory: string, unreadableDirectories: string[]): Promise<string[]> {
  const absolute = resolve(root, directory);
  let entries: Dirent[];
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch {
    unreadableDirectories.push(directory || ".");
    return [];
  }
  const results: string[] = [];
  for (const entry of entries) {
    const child = directory ? `${directory}/${entry.name}` : entry.name;
    const target = resolve(root, child);
    if (entry.isSymbolicLink()) {
      try {
        if (!within(root, await realpath(target))) continue;
      } catch { continue; }
    }
    if (entry.isDirectory()) results.push(...await filesUnder(root, child, unreadableDirectories));
    else if (entry.isFile()) results.push(child);
  }
  return results;
}

async function checksum(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const input = createReadStream(path);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolvePromise());
  });
  return hash.digest("hex");
}

type CsvReport = { headers: string[]; rows: string[][]; rowWidthError: boolean };
// RFC 4180 field parser. The catalog is intentionally parsed positionally.
export function parseCsv(input: string): CsvReport {
  const rows: string[][] = []; let row: string[] = []; let field = ""; let quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    if (quoted) { if (char === '"' && input[index + 1] === '"') { field += '"'; index += 1; } else if (char === '"') quoted = false; else field += char; continue; }
    if (char === '"' && field === "") { quoted = true; continue; }
    if (char === ",") { row.push(field); field = ""; continue; }
    if (char === "\r" && input[index + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; index += 1; continue; }
    if (char === "\n") { row.push(field); rows.push(row); row = []; field = ""; continue; }
    field += char;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  const headers = rows.shift() ?? [];
  return { headers, rows, rowWidthError: rows.some((entry) => entry.length !== headers.length) };
}

function formatFor(path: string): string | null {
  if (path.endsWith(".fit.gz")) return "fit.gz";
  if (path.endsWith(".tcx.gz")) return "tcx.gz";
  const extension = extname(path).toLowerCase();
  return extension ? extension.slice(1) : null;
}

async function gzipReadable(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const input = createReadStream(path); const gzip = createGunzip();
    let done = false; const finish = (value: boolean) => { if (!done) { done = true; resolvePromise(value); } };
    input.on("error", () => finish(false)); gzip.on("error", () => finish(false)); gzip.on("end", () => finish(true));
    input.pipe(gzip); gzip.resume();
  });
}

function safelyReferenced(root: string, approvedDirectory: string, reference: string): boolean {
  if (!reference || isAbsolute(reference) || reference.includes("\\")) return false;
  const candidate = resolve(root, reference);
  return within(resolve(root, approvedDirectory), candidate);
}

export async function validateExport(exportDir: string, database: Database): Promise<ValidationReport> {
  const findings: Finding[] = [];
  let root: string;
  try {
    root = await safeRoot(exportDir);
  } catch (error) {
    logInternalError("export root is not accessible", error);
    return { outcome: "completed-with-errors", summary: { new: 0, changed: 0, unchanged: 0, noLongerObserved: 0 }, findings: [{ code: "EXPORT_ROOT_INVALID", severity: "error", message: "The configured export directory could not be opened." }], sources: [], availability: {} };
  }
  const unreadableDirectories: string[] = [];
  const allFiles = await filesUnder(root, "", unreadableDirectories);
  for (const directory of unreadableDirectories) findings.push({ code: "DIRECTORY_UNREADABLE", severity: "error", path: directory, message: "A directory under the export could not be read." });
  const availability: Record<string, "available" | "available-but-empty" | "unavailable"> = {};
  for (const path of ["activities", "media", "clubs", "routes"]) {
    try {
      const directoryEntries = await readdir(resolve(root, path));
      availability[path] = directoryEntries.length === 0 ? "available-but-empty" : "available";
    } catch { availability[path] = "unavailable"; }
  }
  // Supporting sources are reported so a client can tell a genuinely empty
  // domain from a missing file, whether or not a tool imports it yet.
  for (const path of ["activities.csv", "media.csv", "messaging.json", "shoes.csv", "bikes.csv", "components.csv", "global_challenges.csv", "group_challenges.csv", "clubs.csv", "memberships.csv"]) {
    const source = allFiles.includes(path);
    try {
      if (!source) {
        availability[path] = "unavailable";
      } else if (path.endsWith(".csv")) {
        const csv = parseCsv(await readFile(resolve(root, path), "utf8"));
        availability[path] = csv.rows.length === 0 ? "available-but-empty" : "available";
      } else {
        availability[path] = (await stat(resolve(root, path))).size === 0 ? "available-but-empty" : "available";
      }
    } catch { availability[path] = "unavailable"; }
  }
  if (!allFiles.includes(REQUIRED_CATALOG)) findings.push({ code: "ACTIVITIES_CATALOG_MISSING", severity: "error", path: REQUIRED_CATALOG, message: "Required activities.csv is missing." });
  const previous = database.prepare(`SELECT relative_path, sha256 FROM source_manifest WHERE snapshot_id = (SELECT id FROM export_snapshots WHERE outcome != 'running' ORDER BY id DESC LIMIT 1)`).all() as { relative_path: string; sha256: string | null }[];
  const previousMap = new Map(previous.map((entry) => [entry.relative_path, entry.sha256]));
  const entries: ManifestEntry[] = [];
  const referenced = new Map<string, string[]>();
  for (const relativePath of allFiles) {
    const absolutePath = resolve(root, relativePath);
    try {
      const metadata = await stat(absolutePath); const sourceKind = relativePath.includes("/") ? relativePath.split("/")[0]! : "top-level";
      const contents = relativePath.endsWith(".csv") ? await readFile(absolutePath, "utf8") : undefined;
      let recordCount: number | null = null; let isEmpty = metadata.size === 0; let errorSummary: string | null = null;
      if (contents !== undefined) {
        const csv = parseCsv(contents); recordCount = csv.rows.length; isEmpty = csv.rows.length === 0;
        const duplicates = csv.headers.filter((header, index) => csv.headers.indexOf(header) !== index);
        if (duplicates.length) findings.push({ code: "CSV_DUPLICATE_HEADERS", severity: "warning", path: relativePath, message: `Duplicate headers: ${[...new Set(duplicates)].join(", ")}.` });
        if (csv.rowWidthError) { errorSummary = "CSV row width differs from header width"; findings.push({ code: "CSV_ROW_WIDTH_INVALID", severity: "error", path: relativePath, message: errorSummary }); }
        const filenameIndex = csv.headers.indexOf(relativePath === "activities.csv" ? "Filename" : "Media Filename");
        if (filenameIndex >= 0 && (relativePath === "activities.csv" || basename(relativePath) === "media.csv")) referenced.set(relativePath, csv.rows.map((row) => row[filenameIndex] ?? ""));
      }
      if ((relativePath.endsWith(".fit.gz") || relativePath.endsWith(".tcx.gz")) && !(await gzipReadable(absolutePath))) { errorSummary = "Gzip input is unreadable"; findings.push({ code: "GZIP_UNREADABLE", severity: "error", path: relativePath, message: errorSummary }); }
      const sha256 = await checksum(absolutePath); const old = previousMap.get(relativePath);
      entries.push({ relativePath, sourceKind, format: formatFor(relativePath), sizeBytes: metadata.size, sha256, status: old === undefined ? "new" : old === sha256 ? "unchanged" : "changed", recordCount, isEmpty, errorSummary });
    } catch (error) {
      logInternalError(`failed to process ${relativePath}`, error);
      findings.push({ code: "SOURCE_READ_FAILED", severity: "error", path: relativePath, message: "The source file could not be read." });
      entries.push({
        relativePath,
        sourceKind: relativePath.includes("/") ? relativePath.split("/")[0]! : "top-level",
        format: formatFor(relativePath),
        sizeBytes: null,
        sha256: null,
        status: "read-failed",
        recordCount: null,
        isEmpty: false,
        errorSummary: "Source file could not be read",
      });
    }
  }
  for (const [catalog, paths] of referenced) for (const sourcePath of paths) {
    const directory = catalog === "activities.csv" ? "activities" : "media";
    if (!safelyReferenced(root, directory, sourcePath)) findings.push({ code: "REFERENCED_PATH_UNSAFE", severity: "error", path: catalog, message: `Unsafe referenced path: ${sourcePath}` });
    else if (!allFiles.includes(sourcePath)) findings.push({ code: "REFERENCED_FILE_MISSING", severity: "error", path: sourcePath, message: `Referenced file is missing.` });
  }
  const currentPaths = new Set(entries.map((entry) => entry.relativePath));
  const missing = previous.filter((entry) => !currentPaths.has(entry.relative_path));
  for (const item of missing) findings.push({ code: "SOURCE_NO_LONGER_OBSERVED", severity: "warning", path: item.relative_path, message: "Previously observed source is absent." });
  const now = new Date().toISOString(); const outcome = findings.some((finding) => finding.severity === "error") ? "completed-with-errors" : "completed";
  const summary = { new: entries.filter((entry) => entry.status === "new").length, changed: entries.filter((entry) => entry.status === "changed" || entry.status === "read-failed").length, unchanged: entries.filter((entry) => entry.status === "unchanged").length, noLongerObserved: missing.length };
  const persist = database.transaction(() => {
    const snapshot = database.prepare("INSERT INTO export_snapshots (export_root, started_at, completed_at, outcome, new_count, changed_count, unchanged_count, missing_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(root, now, now, outcome, summary.new, summary.changed, summary.unchanged, summary.noLongerObserved);
    const insert = database.prepare("INSERT INTO source_manifest (snapshot_id, relative_path, source_kind, format, size_bytes, sha256, status, record_count, is_empty, error_summary, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const entry of entries) insert.run(snapshot.lastInsertRowid, entry.relativePath, entry.sourceKind, entry.format, entry.sizeBytes, entry.sha256, entry.status, entry.recordCount, entry.isEmpty ? 1 : 0, entry.errorSummary, now);
    const insertFinding = database.prepare("INSERT INTO findings (snapshot_id, code, severity, path, message) VALUES (?, ?, ?, ?, ?)");
    for (const finding of findings) insertFinding.run(snapshot.lastInsertRowid, finding.code, finding.severity, finding.path ?? null, finding.message);
  }); persist();
  return { outcome, summary, findings, sources: entries, availability };
}
