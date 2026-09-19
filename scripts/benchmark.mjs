#!/usr/bin/env node
// Measures import cost against the configured export. Runs the compiled
// output, so it reports what a user actually runs rather than a transpiled
// approximation. Excluded from `npm test`: it needs a real export and its
// timings are machine-specific.
import { rm, stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../dist/config.js";
import { closeDatabase, openDatabase } from "../dist/database.js";
import { validateExport } from "../dist/validator.js";
import { importActivityCatalog } from "../dist/catalog.js";
import { importGear } from "../dist/gear.js";
import { importDetailedActivityFiles } from "../dist/details.js";

const KEEP = process.argv.includes("--keep");
const REUSE = process.argv.includes("--reuse");

function peakResidentMb() {
  // rss is current, not peak, so it is sampled after each phase and the
  // maximum retained. Node exposes no true high-water mark portably.
  return process.memoryUsage().rss / 1024 / 1024;
}

async function databaseBytes(dataDir) {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try { total += (await stat(join(dataDir, `strava.sqlite${suffix}`))).size; } catch { /* absent */ }
  }
  return total;
}

function countRows(database, table) {
  try { return database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count; }
  catch { return null; }
}

async function main() {
  const config = loadConfig();
  if (config.exportDir === undefined) {
    console.error("Set STRAVA_EXPORT_DIR to the export to benchmark.");
    process.exitCode = 1;
    return;
  }
  // A benchmark must not disturb a real data directory, so it uses its own
  // unless explicitly told to reuse the configured one.
  const dataDir = REUSE ? config.dataDir : join(await mkdtemp(join(tmpdir(), "strava-bench-")), "cache");
  const benchConfig = { ...config, dataDir };

  let peakMb = peakResidentMb();
  const phases = [];
  const time = async (name, run) => {
    const started = process.hrtime.bigint();
    const result = await run();
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    peakMb = Math.max(peakMb, peakResidentMb());
    phases.push({ phase: name, ms: Math.round(ms), ...result });
    return result;
  };

  const database = await openDatabase(benchConfig);
  try {
    await time("validate", async () => {
      const report = await validateExport(config.exportDir, database);
      return { sources: report.sources.length, outcome: report.outcome };
    });
    const snapshotId = database
      .prepare("SELECT id FROM export_snapshots WHERE outcome != 'running' ORDER BY id DESC LIMIT 1")
      .get().id;
    await time("catalog", async () => {
      const imported = await importActivityCatalog(config.exportDir, database, snapshotId, config.timeZone);
      return { activities: countRows(database, "activities"), delta: imported.new ?? undefined };
    });
    await time("supporting", async () => {
      await importGear(config.exportDir, database, snapshotId);
      return { gear: countRows(database, "gear") };
    });
    await time("detailed-cold", async () => {
      const imported = await importDetailedActivityFiles(config.exportDir, database, undefined, config.timeZone, false);
      return { decoded: imported.decoded, unchanged: imported.unchanged, failed: imported.failed };
    });
    await time("detailed-warm", async () => {
      const imported = await importDetailedActivityFiles(config.exportDir, database, undefined, config.timeZone, false);
      return { decoded: imported.decoded, unchanged: imported.unchanged, failed: imported.failed };
    });
    await time("detailed-forced", async () => {
      const imported = await importDetailedActivityFiles(config.exportDir, database, undefined, config.timeZone, true);
      return { decoded: imported.decoded, unchanged: imported.unchanged, failed: imported.failed };
    });

    const rows = {
      activities: countRows(database, "activities"),
      activityStreams: countRows(database, "activity_streams"),
      activityLaps: countRows(database, "activity_laps"),
      activitySplits: countRows(database, "activity_splits"),
      sourceManifest: countRows(database, "source_manifest"),
    };
    const bytes = await databaseBytes(dataDir);

    console.log(JSON.stringify({
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      phases,
      totalMs: phases.reduce((total, phase) => total + phase.ms, 0),
      rows,
      databaseMb: Number((bytes / 1024 / 1024).toFixed(1)),
      peakResidentMb: Number(peakMb.toFixed(1)),
      dataDir: REUSE ? dataDir : "(temporary)",
    }, null, 2));
  } finally {
    closeDatabase(database);
    if (!REUSE && !KEEP) await rm(join(dataDir, ".."), { recursive: true, force: true });
  }
}

await main();
