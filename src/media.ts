import { access } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ColumnDefinition } from "./catalog.js";
import type { Database } from "./database.js";
import { readSupportingCsv, recordSupportingImport, type Availability, type SupportingDelta } from "./supporting.js";

const MEDIA_SOURCE_PATH = "media.csv";
const MEDIA_ROOT = "media";

const MEDIA_COLUMNS: readonly ColumnDefinition[] = [
  { field: "relativePath", sourceHeader: "Media Filename", occurrence: 1, type: "string" },
  { field: "caption", sourceHeader: "Media Caption", occurrence: 1, type: "string" },
];

/**
 * Media paths come from the export as free text, so they are treated as
 * untrusted until proven to sit inside the approved media directory. A path
 * that escapes it, is absolute, or names no file is rejected rather than
 * normalized into something that resolves.
 */
export function safeMediaPath(exportDir: string, candidate: string): string | null {
  const trimmed = candidate.trim();
  if (trimmed === "" || trimmed.startsWith("/") || trimmed.includes("\0")) return null;
  const root = resolve(exportDir, MEDIA_ROOT);
  const resolved = resolve(exportDir, trimmed);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) return null;
  return trimmed;
}

/** The catalog stores several references in one pipe-delimited cell. */
export function splitMediaReferences(cell: string | null): string[] {
  if (cell === null) return [];
  return cell.split("|").map((part) => part.trim()).filter((part) => part !== "");
}

type MediaRecord = {
  relativePath: string;
  caption: string | null;
  source: "media-file" | "activity-catalog-only";
  rowHash: string | null;
  fileStatus: "present" | "missing";
};

/**
 * Imports media references without reading a single byte of media. Both
 * mismatch directions are preserved: a catalog reference absent from
 * media.csv is stored as catalog-only with a null caption, and a media.csv row
 * no activity references is retained with no activity link.
 */
export async function importMedia(exportDir: string, database: Database, snapshotId: number): Promise<SupportingDelta[]> {
  const parsed = await readSupportingCsv(exportDir, MEDIA_SOURCE_PATH, MEDIA_COLUMNS);
  const byPath = new Map<string, MediaRecord>();
  let invalid = 0;

  for (const row of parsed.rows) {
    const raw = row.values.relativePath ?? null;
    const safe = raw === null ? null : safeMediaPath(exportDir, raw);
    if (safe === null) { invalid += 1; continue; }
    byPath.set(safe, { relativePath: safe, caption: row.values.caption ?? null, source: "media-file", rowHash: row.rowHash, fileStatus: "present" });
  }

  const referencing = database.prepare(
    "SELECT id, media_refs AS mediaRefs FROM activities WHERE media_refs IS NOT NULL AND observation_status = 'observed'",
  ).all() as { id: string; mediaRefs: string }[];

  const links: { activityId: string; relativePath: string; sequence: number }[] = [];
  for (const activity of referencing) {
    let sequence = 0;
    for (const reference of splitMediaReferences(activity.mediaRefs)) {
      const safe = safeMediaPath(exportDir, reference);
      if (safe === null) { invalid += 1; continue; }
      if (!byPath.has(safe)) {
        byPath.set(safe, { relativePath: safe, caption: null, source: "activity-catalog-only", rowHash: null, fileStatus: "present" });
      }
      links.push({ activityId: activity.id, relativePath: safe, sequence });
      sequence += 1;
    }
  }

  // Existence is checked once per distinct path, after both sources are known.
  for (const record of byPath.values()) {
    try { await access(resolve(exportDir, record.relativePath)); }
    catch { record.fileStatus = "missing"; }
  }

  let inserted = 0; let changed = 0; let unchanged = 0;
  const existing = database.prepare("SELECT id, row_hash AS rowHash, caption, source, file_status AS fileStatus FROM media WHERE id = ?");
  const apply = database.transaction(() => {
    for (const record of byPath.values()) {
      const prior = existing.get(record.relativePath) as { rowHash: string | null; caption: string | null; source: string; fileStatus: string } | undefined;
      if (prior === undefined) {
        database.prepare(`
          INSERT INTO media (id, relative_path, caption, source, file_status, row_hash, first_seen_snapshot_id, last_seen_snapshot_id, observation_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observed')
        `).run(record.relativePath, record.relativePath, record.caption, record.source, record.fileStatus, record.rowHash, snapshotId, snapshotId);
        inserted += 1;
      } else if (prior.rowHash === record.rowHash && prior.caption === record.caption && prior.source === record.source && prior.fileStatus === record.fileStatus) {
        database.prepare("UPDATE media SET last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?").run(snapshotId, record.relativePath);
        unchanged += 1;
      } else {
        database.prepare("UPDATE media SET caption = ?, source = ?, file_status = ?, row_hash = ?, last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?")
          .run(record.caption, record.source, record.fileStatus, record.rowHash, snapshotId, record.relativePath);
        changed += 1;
      }
    }
    const noLongerObserved = database.prepare(
      "UPDATE media SET observation_status = 'no-longer-observed' WHERE observation_status = 'observed' AND (last_seen_snapshot_id IS NULL OR last_seen_snapshot_id != ?)",
    ).run(snapshotId).changes;

    // Links are rebuilt from the current catalog rather than merged, because
    // an activity losing a photo between exports must lose the link too.
    database.prepare("DELETE FROM activity_media").run();
    const link = database.prepare("INSERT OR IGNORE INTO activity_media (activity_id, media_id, sequence) VALUES (?, ?, ?)");
    for (const entry of links) link.run(entry.activityId, entry.relativePath, entry.sequence);
    return noLongerObserved;
  });
  const noLongerObserved = apply();

  const availability: Availability = parsed.availability === "unavailable" && byPath.size > 0 ? "available" : parsed.availability;
  const delta: SupportingDelta = {
    domain: "media", sourcePath: MEDIA_SOURCE_PATH, availability,
    inserted, changed, unchanged, noLongerObserved, invalid,
  };
  recordSupportingImport(database, snapshotId, delta);
  return [delta];
}

export function listMedia(database: Database, input: { activityId?: string | undefined; source?: "media-file" | "activity-catalog-only" | undefined; fileStatus?: "present" | "missing" | undefined; page?: number | undefined; pageSize?: number | undefined }): object {
  const page = input.page ?? 1; const pageSize = input.pageSize ?? 25;
  const where: string[] = ["m.observation_status = 'observed'"];
  const values: unknown[] = [];
  if (input.activityId !== undefined) { where.push("EXISTS (SELECT 1 FROM activity_media am WHERE am.media_id = m.id AND am.activity_id = ?)"); values.push(input.activityId); }
  if (input.source !== undefined) { where.push("m.source = ?"); values.push(input.source); }
  if (input.fileStatus !== undefined) { where.push("m.file_status = ?"); values.push(input.fileStatus); }
  const clause = where.join(" AND ");

  const total = database.prepare(`SELECT COUNT(*) AS count FROM media m WHERE ${clause}`).get(...values) as { count: number };
  const items = database.prepare(`
    SELECT m.relative_path AS relativePath, m.caption, m.source, m.file_status AS fileStatus,
      (SELECT COUNT(*) FROM activity_media am WHERE am.media_id = m.id) AS activityCount,
      (SELECT group_concat(am.activity_id) FROM activity_media am WHERE am.media_id = m.id) AS activityIds
    FROM media m WHERE ${clause} ORDER BY m.relative_path LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize) as { relativePath: string; caption: string | null; source: string; fileStatus: string; activityCount: number; activityIds: string | null }[];

  return {
    media: items.map((item) => ({
      relativePath: item.relativePath, caption: item.caption, source: item.source, fileStatus: item.fileStatus,
      activityCount: item.activityCount, activityIds: item.activityIds === null ? [] : item.activityIds.split(","),
    })),
    pagination: { page, pageSize, total: total.count, hasMore: page * pageSize < total.count },
    definitions: {
      source: "media-file means the path came from media.csv; activity-catalog-only means an activity referenced it and media.csv did not list it.",
      fileStatus: "present means the referenced file exists inside the export's media directory; missing means it does not.",
      contents: "Only validated relative paths and captions are stored. No media bytes are read and no EXIF, including location, is extracted.",
    },
  };
}
