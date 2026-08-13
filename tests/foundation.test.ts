import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { closeDatabase, openDatabase } from "../src/database.js";
import { validateExport } from "../src/validator.js";

const temporaryRoots: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "strava-mcp-foundation-"));
  temporaryRoots.push(directory);
  return directory;
}

async function fixture(root: string): Promise<{ exportDir: string; dataDir: string }> {
  const exportDir = join(root, "export"); const dataDir = join(root, "cache");
  await mkdir(join(exportDir, "activities"), { recursive: true });
  await mkdir(join(exportDir, "media"), { recursive: true });
  await writeFile(join(exportDir, "activities.csv"), "Activity ID,Filename,Distance,Distance\n1,activities/run.gpx,1000,1\n");
  await writeFile(join(exportDir, "activities", "run.gpx"), "<gpx version=\"1.1\" />");
  await writeFile(join(exportDir, "media.csv"), "Media Filename\nmedia/photo.jpg\n");
  await writeFile(join(exportDir, "media", "photo.jpg"), "synthetic media");
  return { exportDir, dataDir };
}

afterEach(async () => { await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

describe("Foundation validator", () => {
  it("persists an idempotent file manifest without modifying the export", async () => {
    const paths = await fixture(await temporaryDirectory());
    const original = await readFile(join(paths.exportDir, "activities.csv"), "utf8");
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    const first = await validateExport(paths.exportDir, database);
    const second = await validateExport(paths.exportDir, database);
    const snapshots = database.prepare("SELECT count(*) AS count FROM export_snapshots").get() as { count: number };
    closeDatabase(database);

    expect(first.summary.new).toBe(4);
    expect(second.summary).toEqual({ new: 0, changed: 0, unchanged: 4, noLongerObserved: 0 });
    expect(first.findings.some((finding) => finding.code === "CSV_DUPLICATE_HEADERS")).toBe(true);
    expect(snapshots.count).toBe(2);
    expect(await readFile(join(paths.exportDir, "activities.csv"), "utf8")).toBe(original);
  });

  it("reports changed, absent, unsafe, and missing referenced files", async () => {
    const paths = await fixture(await temporaryDirectory());
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    await validateExport(paths.exportDir, database);
    await writeFile(join(paths.exportDir, "activities.csv"), "Activity ID,Filename\n1,../outside.gpx\n2,activities/missing.gpx\n");
    await rm(join(paths.exportDir, "media", "photo.jpg"));
    const report = await validateExport(paths.exportDir, database);
    closeDatabase(database);

    expect(report.summary.changed).toBe(1);
    expect(report.summary.noLongerObserved).toBe(1);
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["REFERENCED_PATH_UNSAFE", "REFERENCED_FILE_MISSING", "SOURCE_NO_LONGER_OBSERVED"]));
  });

  it("keeps validating when a CSV is malformed or a compressed activity is unreadable", async () => {
    const paths = await fixture(await temporaryDirectory());
    await writeFile(join(paths.exportDir, "activities.csv"), "Activity ID,Filename\n1,activities/run.gpx,extra-field\n");
    await writeFile(join(paths.exportDir, "activities", "broken.fit.gz"), "not a gzip stream");
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    const report = await validateExport(paths.exportDir, database);
    closeDatabase(database);

    expect(report.outcome).toBe("completed-with-errors");
    expect(report.findings.map((finding) => finding.code)).toEqual(expect.arrayContaining(["CSV_ROW_WIDTH_INVALID", "GZIP_UNREADABLE"]));
  });

  it("keeps validating when a directory cannot be read, without leaking filesystem details", async () => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return;
    const paths = await fixture(await temporaryDirectory());
    const lockedDir = join(paths.exportDir, "activities", "locked");
    await mkdir(lockedDir);
    await writeFile(join(lockedDir, "secret.gpx"), "unreachable");
    await chmod(lockedDir, 0o000);
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    try {
      const report = await validateExport(paths.exportDir, database);
      expect(report.outcome).toBe("completed-with-errors");
      expect(report.findings.some((finding) => finding.code === "DIRECTORY_UNREADABLE")).toBe(true);
      expect(report.findings.every((finding) => !finding.message.includes(paths.exportDir))).toBe(true);
    } finally {
      await chmod(lockedDir, 0o755);
      closeDatabase(database);
    }
  });

  it("keeps validating when a source file becomes unreadable, without leaking filesystem details", async () => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return;
    const paths = await fixture(await temporaryDirectory());
    const blockedFile = join(paths.exportDir, "activities", "run.gpx");
    await chmod(blockedFile, 0o000);
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    try {
      const report = await validateExport(paths.exportDir, database);
      expect(report.outcome).toBe("completed-with-errors");
      expect(report.findings.some((finding) => finding.code === "SOURCE_READ_FAILED" && finding.path === "activities/run.gpx")).toBe(true);
      expect(report.findings.every((finding) => !finding.message.includes(paths.exportDir))).toBe(true);
      const manifest = database.prepare(
        "SELECT sha256, status, error_summary FROM source_manifest WHERE snapshot_id = (SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1) AND relative_path = ?",
      ).get("activities/run.gpx") as { sha256: string | null; status: string; error_summary: string | null };
      expect(manifest).toEqual({ sha256: null, status: "read-failed", error_summary: "Source file could not be read" });
    } finally {
      await chmod(blockedFile, 0o644);
      closeDatabase(database);
    }
  });

  it("records a source as changed when it becomes readable after a read failure", async () => {
    if (process.platform === "win32" || (process.getuid && process.getuid() === 0)) return;
    const paths = await fixture(await temporaryDirectory());
    const blockedFile = join(paths.exportDir, "activities", "run.gpx");
    await chmod(blockedFile, 0o000);
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    try {
      const failed = await validateExport(paths.exportDir, database);
      await chmod(blockedFile, 0o644);
      const recovered = await validateExport(paths.exportDir, database);
      expect(failed.summary.changed).toBe(1);
      expect(recovered.summary.changed).toBe(1);
      expect(recovered.sources.find((source) => source.relativePath === "activities/run.gpx")?.status).toBe("changed");
    } finally {
      await chmod(blockedFile, 0o644);
      closeDatabase(database);
    }
  });

  it("reports and persists every finding without truncation", async () => {
    const paths = await fixture(await temporaryDirectory());
    const rows = Array.from({ length: 150 }, (_, index) => `${index},activities/missing-${index}.gpx`).join("\n");
    await writeFile(join(paths.exportDir, "activities.csv"), `Activity ID,Filename\n${rows}\n`);
    const config = loadConfig({ STRAVA_EXPORT_DIR: paths.exportDir, STRAVA_MCP_DATA_DIR: paths.dataDir });
    const database = await openDatabase(config);
    const report = await validateExport(paths.exportDir, database);
    const persistedCount = database.prepare(
      "SELECT count(*) AS count FROM findings WHERE snapshot_id = (SELECT id FROM export_snapshots ORDER BY id DESC LIMIT 1)",
    ).get() as { count: number };
    closeDatabase(database);

    const missingFindings = report.findings.filter((finding) => finding.code === "REFERENCED_FILE_MISSING");
    expect(missingFindings.length).toBe(150);
    expect(persistedCount.count).toBe(report.findings.length);
  });
});
