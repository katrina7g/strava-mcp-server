import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildPositionalColumnMap, type ColumnDefinition } from "./catalog.js";
import type { Database } from "./database.js";
import { parseCsv } from "./validator.js";

export type Availability = "available" | "available-but-empty" | "unavailable";

export type SupportingRow = Readonly<{
  rowNumber: number;
  rowHash: string;
  values: Readonly<Record<string, string | null>>;
}>;

export type SupportingSource = Readonly<{
  availability: Availability;
  rows: readonly SupportingRow[];
}>;

export type SupportingDelta = {
  domain: string;
  sourcePath: string;
  availability: Availability;
  inserted: number;
  changed: number;
  unchanged: number;
  noLongerObserved: number;
  invalid: number;
};

/**
 * Reads one supporting CSV positionally against a column definition list.
 * A source that is missing is `unavailable` and a source with headers but no
 * rows is `available-but-empty`; neither is an error, because a valid export
 * may simply contain no bikes, clubs, or routes.
 */
export async function readSupportingCsv(
  exportDir: string,
  sourcePath: string,
  columns: readonly ColumnDefinition[],
): Promise<SupportingSource> {
  let contents: string;
  try {
    contents = await readFile(join(exportDir, sourcePath), "utf8");
  } catch {
    return Object.freeze({ availability: "unavailable" as const, rows: [] });
  }
  const csv = parseCsv(contents);
  const map = buildPositionalColumnMap(csv.headers);
  const rows = csv.rows.map((values, index) => {
    const record: Record<string, string | null> = {};
    for (const definition of columns) {
      const column = map.find((candidate) => candidate.sourceHeader === definition.sourceHeader);
      const raw = column === undefined ? undefined : values[column.index];
      const trimmed = raw?.trim();
      record[definition.field] = trimmed ? trimmed : null;
    }
    return Object.freeze({
      rowNumber: index + 2,
      rowHash: createHash("sha256").update(JSON.stringify({ headers: csv.headers, values })).digest("hex"),
      values: Object.freeze(record),
    });
  });
  return Object.freeze({ availability: rows.length === 0 ? "available-but-empty" as const : "available" as const, rows });
}

export type ObservedRecord = Readonly<{ id: string; rowHash: string | null; columns: Readonly<Record<string, string | number | null>> }>;

/**
 * Upserts current-state records for one domain and marks anything absent from
 * this snapshot as no-longer-observed rather than deleting it, matching the
 * catalog's contract. The table and column names come from fixed descriptors,
 * never from user input.
 */
export function upsertObservedRecords(
  database: Database,
  table: "gear",
  records: readonly ObservedRecord[],
  snapshotId: number,
  scope?: { column: string; value: string },
): { inserted: number; changed: number; unchanged: number; noLongerObserved: number } {
  let inserted = 0; let changed = 0; let unchanged = 0;
  const existing = database.prepare(`SELECT id, row_hash AS rowHash FROM ${table} WHERE id = ?`);

  const apply = database.transaction(() => {
    for (const record of records) {
      const columns = Object.keys(record.columns);
      const prior = existing.get(record.id) as { id: string; rowHash: string | null } | undefined;
      if (prior === undefined) {
        const names = ["id", "row_hash", "first_seen_snapshot_id", "last_seen_snapshot_id", "observation_status", ...columns];
        database.prepare(`INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
          .run(record.id, record.rowHash, snapshotId, snapshotId, "observed", ...columns.map((name) => record.columns[name] ?? null));
        inserted += 1;
      } else if (prior.rowHash === record.rowHash) {
        database.prepare(`UPDATE ${table} SET last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?`).run(snapshotId, record.id);
        unchanged += 1;
      } else {
        const assignments = columns.map((name) => `${name} = ?`).join(", ");
        database.prepare(`UPDATE ${table} SET row_hash = ?, last_seen_snapshot_id = ?, observation_status = 'observed', ${assignments} WHERE id = ?`)
          .run(record.rowHash, snapshotId, ...columns.map((name) => record.columns[name] ?? null), record.id);
        changed += 1;
      }
    }
    const where = scope === undefined ? "" : ` AND ${scope.column} = ?`;
    const values = scope === undefined ? [snapshotId] : [snapshotId, scope.value];
    return database.prepare(`UPDATE ${table} SET observation_status = 'no-longer-observed' WHERE observation_status = 'observed' AND (last_seen_snapshot_id IS NULL OR last_seen_snapshot_id != ?)${where}`).run(...values).changes;
  });
  const noLongerObserved = apply();
  return { inserted, changed, unchanged, noLongerObserved };
}

export function recordSupportingImport(database: Database, snapshotId: number, delta: SupportingDelta): void {
  database.prepare(`
    INSERT OR REPLACE INTO supporting_imports
      (snapshot_id, domain, source_path, availability, imported_at, inserted_count, changed_count, unchanged_count, missing_count, invalid_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(snapshotId, delta.domain, delta.sourcePath, delta.availability, new Date().toISOString(), delta.inserted, delta.changed, delta.unchanged, delta.noLongerObserved, delta.invalid);
}
