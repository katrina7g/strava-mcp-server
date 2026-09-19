import { parseExportTimestamp, type ColumnDefinition } from "./catalog.js";
import type { Database } from "./database.js";
import { readSupportingCsv, recordSupportingImport, type Availability, type SupportingDelta } from "./supporting.js";

/**
 * The social sources are the only ones describing other people. followers.csv
 * and following.csv are lists of third-party athlete IDs, reactions.csv points
 * at parent activities that need not be this account's, and comments.csv holds
 * free text. None of that is stored: this importer counts rows and discards
 * every value that could identify a person or reproduce what they wrote, so
 * there is nothing for a tool to leak.
 */
const FOLLOW_COLUMNS: readonly ColumnDefinition[] = [
  { field: "followStatus", sourceHeader: "Follow Status", occurrence: 1, type: "string" },
  { field: "favoriteStatus", sourceHeader: "Favorite Status", occurrence: 1, type: "string" },
];

const REACTION_COLUMNS: readonly ColumnDefinition[] = [
  { field: "reactionDate", sourceHeader: "Reaction Date", occurrence: 1, type: "date" },
  { field: "reactionType", sourceHeader: "Reaction Type", occurrence: 1, type: "string" },
  { field: "parentType", sourceHeader: "Parent Type", occurrence: 1, type: "string" },
];

const COMMENT_COLUMNS: readonly ColumnDefinition[] = [
  { field: "commentDate", sourceHeader: "Comment Date", occurrence: 1, type: "date" },
];

type Counter = Map<string, Map<string, number>>;

function bump(counter: Counter, dimensionKind: string, dimension: string): void {
  const byDimension = counter.get(dimensionKind) ?? new Map<string, number>();
  byDimension.set(dimension, (byDimension.get(dimension) ?? 0) + 1);
  counter.set(dimensionKind, byDimension);
}

/** Month resolution only: a precise timestamp for a reaction on someone
 * else's activity says more about them than an aggregate needs to. */
function monthOf(value: string | null): string {
  const parsed = parseExportTimestamp(value ?? undefined);
  return parsed === null ? "unknown" : parsed.slice(0, 7);
}

export async function importSocial(exportDir: string, database: Database, snapshotId: number): Promise<SupportingDelta[]> {
  const counters = new Map<string, Counter>();
  const availabilities: Availability[] = [];
  let total = 0;

  const counterFor = (metric: string): Counter => {
    const existing = counters.get(metric) ?? new Map<string, Map<string, number>>();
    counters.set(metric, existing);
    return existing;
  };

  for (const [metric, sourcePath] of [["followers", "followers.csv"], ["following", "following.csv"]] as const) {
    const parsed = await readSupportingCsv(exportDir, sourcePath, FOLLOW_COLUMNS);
    availabilities.push(parsed.availability);
    const counter = counterFor(metric);
    bump(counter, "total", "total");
    counter.get("total")!.set("total", parsed.rows.length);
    for (const row of parsed.rows) {
      bump(counter, "followStatus", row.values.followStatus ?? "unknown");
      bump(counter, "favoriteStatus", row.values.favoriteStatus ?? "none");
    }
    total += parsed.rows.length;
  }

  const reactions = await readSupportingCsv(exportDir, "reactions.csv", REACTION_COLUMNS);
  availabilities.push(reactions.availability);
  const reactionCounter = counterFor("reactions");
  reactionCounter.set("total", new Map([["total", reactions.rows.length]]));
  for (const row of reactions.rows) {
    bump(reactionCounter, "reactionType", row.values.reactionType ?? "unknown");
    bump(reactionCounter, "parentType", row.values.parentType ?? "unknown");
    bump(reactionCounter, "month", monthOf(row.values.reactionDate ?? null));
  }
  total += reactions.rows.length;

  const comments = await readSupportingCsv(exportDir, "comments.csv", COMMENT_COLUMNS);
  availabilities.push(comments.availability);
  const commentCounter = counterFor("comments");
  commentCounter.set("total", new Map([["total", comments.rows.length]]));
  for (const row of comments.rows) bump(commentCounter, "month", monthOf(row.values.commentDate ?? null));
  total += comments.rows.length;

  const write = database.transaction(() => {
    database.prepare("DELETE FROM social_counts WHERE snapshot_id = ?").run(snapshotId);
    const insert = database.prepare("INSERT INTO social_counts (snapshot_id, metric, dimension_kind, dimension, count) VALUES (?, ?, ?, ?, ?)");
    for (const [metric, counter] of counters) {
      for (const [dimensionKind, byDimension] of counter) {
        for (const [dimension, count] of byDimension) insert.run(snapshotId, metric, dimensionKind, dimension, count);
      }
    }
  });
  write();

  const availability: Availability = availabilities.includes("available") ? "available"
    : availabilities.includes("available-but-empty") ? "available-but-empty" : "unavailable";
  // Counts replace one another wholesale per snapshot, so the insert/change
  // vocabulary the row-level domains use does not apply here.
  const delta: SupportingDelta = {
    domain: "social", sourcePath: "followers.csv, following.csv, reactions.csv, comments.csv",
    availability, inserted: total, changed: 0, unchanged: 0, noLongerObserved: 0, invalid: 0,
  };
  recordSupportingImport(database, snapshotId, delta);
  return [delta];
}

export function getSocialSummary(database: Database): object {
  const snapshot = database.prepare("SELECT MAX(snapshot_id) AS id FROM social_counts").get() as { id: number | null };
  if (snapshot.id === null) {
    return {
      available: false,
      message: "No social data has been imported; run import_supporting_data.",
      limitations: ["This export describes outbound activity only. Kudos and comments received cannot be derived from it."],
    };
  }
  const rows = database.prepare("SELECT metric, dimension_kind AS dimensionKind, dimension, count FROM social_counts WHERE snapshot_id = ? ORDER BY metric, dimension_kind, dimension")
    .all(snapshot.id) as { metric: string; dimensionKind: string; dimension: string; count: number }[];

  const shaped: Record<string, Record<string, unknown>> = {};
  for (const row of rows) {
    const metric = shaped[row.metric] ?? {};
    if (row.dimensionKind === "total") metric.total = row.count;
    else {
      const group = (metric[row.dimensionKind] ?? {}) as Record<string, number>;
      group[row.dimension] = row.count;
      metric[row.dimensionKind] = group;
    }
    shaped[row.metric] = metric;
  }

  return {
    available: true,
    followers: shaped.followers ?? { total: 0 },
    following: shaped.following ?? { total: 0 },
    reactions: shaped.reactions ?? { total: 0 },
    comments: shaped.comments ?? { total: 0 },
    definitions: {
      scope: "Every figure here is outbound: reactions this account gave and comments it wrote.",
      month: "Month buckets are ISO year-month in UTC.",
    },
    limitations: [
      "Only counts are stored. No follower, following, or parent activity identifier and no comment text enters the database, so none can be returned.",
      "Kudos and comments received are absent from a Strava export and cannot be derived, so no inbound figure is reported.",
    ],
  };
}
