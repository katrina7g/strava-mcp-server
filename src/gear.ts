import type { ColumnDefinition } from "./catalog.js";
import type { Database } from "./database.js";
import { normalizeMatchKey } from "./identity.js";
import {
  readSupportingCsv, recordSupportingImport, upsertObservedRecords,
  type Availability, type ObservedRecord, type SupportingDelta,
} from "./supporting.js";

export type GearType = "shoe" | "bike" | "component";

type GearSource = Readonly<{ gearType: GearType; sourcePath: string; columns: readonly ColumnDefinition[] }>;

const GEAR_SOURCES: readonly GearSource[] = [
  {
    gearType: "shoe", sourcePath: "shoes.csv",
    columns: [
      { field: "name", sourceHeader: "Shoe Name", occurrence: 1, type: "string" },
      { field: "brand", sourceHeader: "Shoe Brand", occurrence: 1, type: "string" },
      { field: "model", sourceHeader: "Shoe Model", occurrence: 1, type: "string" },
      { field: "defaultSportTypes", sourceHeader: "Shoe Default Sport Types", occurrence: 1, type: "string" },
    ],
  },
  {
    gearType: "bike", sourcePath: "bikes.csv",
    columns: [
      { field: "name", sourceHeader: "Bike Name", occurrence: 1, type: "string" },
      { field: "brand", sourceHeader: "Bike Brand", occurrence: 1, type: "string" },
      { field: "model", sourceHeader: "Bike Model", occurrence: 1, type: "string" },
      { field: "defaultSportTypes", sourceHeader: "Bike Default Sport Types", occurrence: 1, type: "string" },
    ],
  },
  {
    gearType: "component", sourcePath: "components.csv",
    columns: [
      { field: "name", sourceHeader: "Bike Name", occurrence: 1, type: "string" },
      { field: "componentType", sourceHeader: "Component Type", occurrence: 1, type: "string" },
      { field: "brand", sourceHeader: "Component Brand", occurrence: 1, type: "string" },
      { field: "model", sourceHeader: "Component Model", occurrence: 1, type: "string" },
    ],
  },
];

/**
 * The export gives gear no identifier, and the catalog references it by the
 * free text in `Activity Gear`. In the reference export every `shoes.csv` row
 * has a blank `Shoe Name` while the catalog holds "Brooks Revel 3", so the
 * display name falls back to brand and model. Punctuation is preserved because
 * model names depend on it; only case and whitespace are normalized away.
 */
export function gearDisplayName(values: { name?: string | null; brand?: string | null; model?: string | null }): string | null {
  if (values.name) return values.name;
  const parts = [values.brand, values.model].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" ") : null;
}

export { normalizeMatchKey as gearMatchKey } from "./identity.js";

function gearId(gearType: GearType, matchKey: string): string {
  return `${gearType}:${matchKey}`;
}

/**
 * Imports the gear catalogue and reconciles it with the gear names the
 * activity catalog actually references. Both mismatch directions are normal
 * and non-fatal: a retired shoe may appear only on activities, and a gear-file
 * row may never have been used.
 */
export async function importGear(exportDir: string, database: Database, snapshotId: number): Promise<SupportingDelta[]> {
  const deltas: SupportingDelta[] = [];
  const records: ObservedRecord[] = [];
  const availabilityByType = new Map<GearType, Availability>();
  let invalid = 0;

  for (const source of GEAR_SOURCES) {
    const parsed = await readSupportingCsv(exportDir, source.sourcePath, source.columns);
    availabilityByType.set(source.gearType, parsed.availability);
    const typeRecords: ObservedRecord[] = [];
    for (const row of parsed.rows) {
      const displayName = gearDisplayName(row.values);
      if (displayName === null) { invalid += 1; continue; }
      const matchKey = normalizeMatchKey(displayName);
      typeRecords.push({
        id: gearId(source.gearType, matchKey),
        rowHash: row.rowHash,
        columns: {
          gear_type: source.gearType, display_name: displayName, match_key: matchKey,
          brand: row.values.brand ?? null, model: row.values.model ?? null,
          default_sport_types: row.values.defaultSportTypes ?? null, source: "gear-file",
        },
      });
    }
    records.push(...typeRecords);
    deltas.push({ domain: "gear", sourcePath: source.sourcePath, availability: parsed.availability, inserted: 0, changed: 0, unchanged: 0, noLongerObserved: 0, invalid: 0 });
  }

  // A gear name used by an activity but absent from every gear file is still
  // real gear; synthesising it keeps usage reportable instead of dropping it.
  const referenced = database.prepare("SELECT DISTINCT gear_name AS name, gear_match_key AS matchKey FROM activities WHERE gear_match_key IS NOT NULL AND observation_status = 'observed'").all() as { name: string; matchKey: string }[];
  const known = new Set(records.map((record) => record.columns.match_key));
  for (const gear of referenced) {
    if (known.has(gear.matchKey)) continue;
    records.push({
      id: gearId("shoe", gear.matchKey), rowHash: `activity-catalog:${gear.matchKey}`,
      columns: { gear_type: "shoe", display_name: gear.name, match_key: gear.matchKey, brand: null, model: null, default_sport_types: null, source: "activity-catalog-only" },
    });
  }

  const applied = upsertObservedRecords(database, "gear", records, snapshotId);
  const summary: SupportingDelta = {
    domain: "gear", sourcePath: GEAR_SOURCES.map((source) => source.sourcePath).join(", "),
    availability: [...availabilityByType.values()].some((value) => value === "available") ? "available"
      : [...availabilityByType.values()].some((value) => value === "available-but-empty") ? "available-but-empty" : "unavailable",
    ...applied, invalid,
  };
  for (const delta of deltas) recordSupportingImport(database, snapshotId, delta);
  recordSupportingImport(database, snapshotId, { ...summary, sourcePath: "gear" });
  return [summary];
}

export function getGear(database: Database, input: { gearType?: GearType | undefined; page?: number | undefined; pageSize?: number | undefined }): object {
  const page = input.page ?? 1; const pageSize = input.pageSize ?? 25;
  const where = ["g.observation_status = 'observed'"]; const values: unknown[] = [];
  if (input.gearType !== undefined) { where.push("g.gear_type = ?"); values.push(input.gearType); }
  const clause = where.join(" AND ");
  const total = database.prepare(`SELECT COUNT(*) AS count FROM gear g WHERE ${clause}`).get(...values) as { count: number };
  const items = database.prepare(`
    SELECT g.display_name AS name, g.gear_type AS gearType, g.brand, g.model,
      g.default_sport_types AS defaultSportTypes, g.source,
      (SELECT COUNT(*) FROM activities a WHERE a.gear_match_key = g.match_key AND a.observation_status = 'observed') AS activityCount,
      (SELECT COALESCE(SUM(a.distance_meters), 0) FROM activities a WHERE a.gear_match_key = g.match_key AND a.observation_status = 'observed') AS distanceMeters
    FROM gear g WHERE ${clause}
    ORDER BY activityCount DESC, g.display_name ASC LIMIT ? OFFSET ?
  `).all(...values, pageSize, (page - 1) * pageSize);
  const unmatched = database.prepare("SELECT COUNT(*) AS count FROM gear WHERE observation_status = 'observed' AND source = 'activity-catalog-only'").get() as { count: number };

  return {
    gear: items,
    pagination: { page, pageSize, total: total.count, hasMore: page * pageSize < total.count },
    dataAvailability: total.count === 0
      ? "No gear data was included in this export."
      : `${total.count} gear item(s) imported; ${unmatched.count} inferred from activity references only.`,
    definitions: {
      name: "The gear file's own name when present, otherwise its brand and model joined, because this export leaves gear names blank.",
      activityCount: "Activities whose catalog gear text matches this item after case and whitespace normalization.",
      source: "gear-file when the item came from shoes/bikes/components, activity-catalog-only when it was referenced by an activity but absent from those files.",
    },
  };
}
