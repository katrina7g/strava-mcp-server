import { parseExportTimestamp, type ColumnDefinition } from "./catalog.js";
import type { Database } from "./database.js";
import { normalizeMatchKey } from "./identity.js";
import { readSupportingCsv, recordSupportingImport, type Availability, type SupportingDelta } from "./supporting.js";

type ChallengeScope = "global" | "group";

const CHALLENGE_SOURCES: readonly { scope: ChallengeScope; sourcePath: string }[] = [
  { scope: "global", sourcePath: "global_challenges.csv" },
  { scope: "group", sourcePath: "group_challenges.csv" },
];

const CHALLENGE_COLUMNS: readonly ColumnDefinition[] = [
  { field: "joinedAt", sourceHeader: "Join Date", occurrence: 1, type: "date" },
  { field: "name", sourceHeader: "Name", occurrence: 1, type: "string" },
  { field: "completed", sourceHeader: "Completed", occurrence: 1, type: "boolean" },
];

const CLUB_COLUMNS: readonly ColumnDefinition[] = [
  { field: "name", sourceHeader: "Club Name", occurrence: 1, type: "string" },
  { field: "description", sourceHeader: "Club Description", occurrence: 1, type: "string" },
  { field: "clubType", sourceHeader: "Club Type", occurrence: 1, type: "string" },
  { field: "sport", sourceHeader: "Club Sport", occurrence: 1, type: "string" },
  { field: "city", sourceHeader: "City", occurrence: 1, type: "string" },
  { field: "state", sourceHeader: "State", occurrence: 1, type: "string" },
  { field: "country", sourceHeader: "Country", occurrence: 1, type: "string" },
  { field: "website", sourceHeader: "Club Website", occurrence: 1, type: "string" },
];

const MEMBERSHIP_COLUMNS: readonly ColumnDefinition[] = [
  { field: "joinedAt", sourceHeader: "Join Date", occurrence: 1, type: "date" },
  { field: "name", sourceHeader: "Club Name", occurrence: 1, type: "string" },
];

/** The export writes booleans as `true`/`false` text. */
function parseFlag(value: string | null): number | null {
  if (value === null) return null;
  const text = value.trim().toLowerCase();
  if (text === "true") return 1;
  if (text === "false") return 0;
  return null;
}

function markUnobserved(database: Database, table: "challenges" | "clubs" | "club_memberships", snapshotId: number): number {
  return database.prepare(
    `UPDATE ${table} SET observation_status = 'no-longer-observed' WHERE observation_status = 'observed' AND (last_seen_snapshot_id IS NULL OR last_seen_snapshot_id != ?)`,
  ).run(snapshotId).changes;
}

function combine(values: readonly Availability[]): Availability {
  if (values.includes("available")) return "available";
  return values.includes("available-but-empty") ? "available-but-empty" : "unavailable";
}

/**
 * Imports challenges, clubs and memberships. Each is a table descriptor over
 * the shared supporting-CSV reader; none needs domain-specific decoding. An
 * empty source stays available-but-empty rather than becoming an error, and a
 * membership naming an unknown club synthesizes that club rather than dropping
 * the membership.
 */
export async function importCommunity(exportDir: string, database: Database, snapshotId: number): Promise<SupportingDelta[]> {
  const deltas: SupportingDelta[] = [];

  // Challenges
  const challengeAvailability: Availability[] = [];
  let challengeInserted = 0; let challengeChanged = 0; let challengeUnchanged = 0; let challengeInvalid = 0;
  const challengeUpsert = database.transaction((rows: { id: string; scope: ChallengeScope; name: string; joinedAt: string | null; completed: number | null; rowHash: string }[]) => {
    for (const row of rows) {
      const prior = database.prepare("SELECT row_hash AS rowHash FROM challenges WHERE id = ?").get(row.id) as { rowHash: string | null } | undefined;
      if (prior === undefined) {
        database.prepare("INSERT INTO challenges (id, scope, name, joined_at, completed, row_hash, first_seen_snapshot_id, last_seen_snapshot_id, observation_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'observed')")
          .run(row.id, row.scope, row.name, row.joinedAt, row.completed, row.rowHash, snapshotId, snapshotId);
        challengeInserted += 1;
      } else if (prior.rowHash === row.rowHash) {
        database.prepare("UPDATE challenges SET last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?").run(snapshotId, row.id);
        challengeUnchanged += 1;
      } else {
        database.prepare("UPDATE challenges SET scope = ?, name = ?, joined_at = ?, completed = ?, row_hash = ?, last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?")
          .run(row.scope, row.name, row.joinedAt, row.completed, row.rowHash, snapshotId, row.id);
        challengeChanged += 1;
      }
    }
  });

  const challengeRows: { id: string; scope: ChallengeScope; name: string; joinedAt: string | null; completed: number | null; rowHash: string }[] = [];
  for (const source of CHALLENGE_SOURCES) {
    const parsed = await readSupportingCsv(exportDir, source.sourcePath, CHALLENGE_COLUMNS);
    challengeAvailability.push(parsed.availability);
    for (const row of parsed.rows) {
      const name = row.values.name ?? null;
      if (name === null) { challengeInvalid += 1; continue; }
      // A recurring challenge can be joined more than once under the same
      // name, so the join date is part of its identity. Without it the second
      // join overwrites the first and the count silently drops. A row with no
      // date falls back to its content hash rather than colliding.
      const joinedAt = parseExportTimestamp(row.values.joinedAt ?? undefined);
      challengeRows.push({
        id: `${source.scope}:${normalizeMatchKey(name)}:${joinedAt ?? row.rowHash}`,
        scope: source.scope, name, joinedAt,
        completed: parseFlag(row.values.completed ?? null), rowHash: row.rowHash,
      });
    }
    deltas.push({ domain: "challenges", sourcePath: source.sourcePath, availability: parsed.availability, inserted: 0, changed: 0, unchanged: 0, noLongerObserved: 0, invalid: 0 });
  }
  challengeUpsert(challengeRows);
  const challengeSummary: SupportingDelta = {
    domain: "challenges", sourcePath: CHALLENGE_SOURCES.map((source) => source.sourcePath).join(", "),
    availability: combine(challengeAvailability),
    inserted: challengeInserted, changed: challengeChanged, unchanged: challengeUnchanged,
    noLongerObserved: markUnobserved(database, "challenges", snapshotId), invalid: challengeInvalid,
  };

  // Clubs and memberships
  const clubsParsed = await readSupportingCsv(exportDir, "clubs.csv", CLUB_COLUMNS);
  const membershipsParsed = await readSupportingCsv(exportDir, "memberships.csv", MEMBERSHIP_COLUMNS);
  type ClubRecord = { id: string; name: string; values: Record<string, string | null>; source: "club-file" | "membership-only"; rowHash: string | null };
  const clubs = new Map<string, ClubRecord>();
  let clubInvalid = 0;

  for (const row of clubsParsed.rows) {
    const name = row.values.name ?? null;
    if (name === null) { clubInvalid += 1; continue; }
    clubs.set(normalizeMatchKey(name), { id: normalizeMatchKey(name), name, values: { ...row.values }, source: "club-file", rowHash: row.rowHash });
  }
  const memberships: { clubId: string; joinedAt: string | null; rowHash: string }[] = [];
  for (const row of membershipsParsed.rows) {
    const name = row.values.name ?? null;
    if (name === null) { clubInvalid += 1; continue; }
    const id = normalizeMatchKey(name);
    if (!clubs.has(id)) {
      clubs.set(id, { id, name, values: {}, source: "membership-only", rowHash: null });
    }
    memberships.push({ clubId: id, joinedAt: parseExportTimestamp(row.values.joinedAt ?? undefined), rowHash: row.rowHash });
  }

  let clubInserted = 0; let clubChanged = 0; let clubUnchanged = 0;
  const clubUpsert = database.transaction(() => {
    for (const club of clubs.values()) {
      const prior = database.prepare("SELECT row_hash AS rowHash, source FROM clubs WHERE id = ?").get(club.id) as { rowHash: string | null; source: string } | undefined;
      const columns = [club.name, club.values.description ?? null, club.values.clubType ?? null, club.values.sport ?? null, club.values.city ?? null, club.values.state ?? null, club.values.country ?? null, club.values.website ?? null, club.source, club.rowHash];
      if (prior === undefined) {
        database.prepare("INSERT INTO clubs (name, description, club_type, sport, city, state, country, website, source, row_hash, id, first_seen_snapshot_id, last_seen_snapshot_id, observation_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'observed')")
          .run(...columns, club.id, snapshotId, snapshotId);
        clubInserted += 1;
      } else if (prior.rowHash === club.rowHash && prior.source === club.source) {
        database.prepare("UPDATE clubs SET last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?").run(snapshotId, club.id);
        clubUnchanged += 1;
      } else {
        database.prepare("UPDATE clubs SET name = ?, description = ?, club_type = ?, sport = ?, city = ?, state = ?, country = ?, website = ?, source = ?, row_hash = ?, last_seen_snapshot_id = ?, observation_status = 'observed' WHERE id = ?")
          .run(...columns, snapshotId, club.id);
        clubChanged += 1;
      }
    }
    for (const membership of memberships) {
      const prior = database.prepare("SELECT row_hash AS rowHash FROM club_memberships WHERE club_id = ?").get(membership.clubId) as { rowHash: string | null } | undefined;
      if (prior === undefined) {
        database.prepare("INSERT INTO club_memberships (club_id, joined_at, row_hash, first_seen_snapshot_id, last_seen_snapshot_id, observation_status) VALUES (?, ?, ?, ?, ?, 'observed')")
          .run(membership.clubId, membership.joinedAt, membership.rowHash, snapshotId, snapshotId);
      } else {
        database.prepare("UPDATE club_memberships SET joined_at = ?, row_hash = ?, last_seen_snapshot_id = ?, observation_status = 'observed' WHERE club_id = ?")
          .run(membership.joinedAt, membership.rowHash, snapshotId, membership.clubId);
      }
    }
  });
  clubUpsert();

  const clubSummary: SupportingDelta = {
    domain: "clubs", sourcePath: "clubs.csv, memberships.csv",
    availability: combine([clubsParsed.availability, membershipsParsed.availability]),
    inserted: clubInserted, changed: clubChanged, unchanged: clubUnchanged,
    noLongerObserved: markUnobserved(database, "clubs", snapshotId) + markUnobserved(database, "club_memberships", snapshotId),
    invalid: clubInvalid,
  };

  for (const delta of deltas) recordSupportingImport(database, snapshotId, delta);
  recordSupportingImport(database, snapshotId, { ...challengeSummary, sourcePath: "challenges" });
  recordSupportingImport(database, snapshotId, clubSummary);
  return [challengeSummary, clubSummary];
}

export function getChallenges(database: Database, input: { scope?: ChallengeScope | undefined; completed?: boolean | undefined; page?: number | undefined; pageSize?: number | undefined }): object {
  const page = input.page ?? 1; const pageSize = input.pageSize ?? 25;
  const where: string[] = ["observation_status = 'observed'"];
  const values: unknown[] = [];
  if (input.scope !== undefined) { where.push("scope = ?"); values.push(input.scope); }
  if (input.completed !== undefined) { where.push("completed = ?"); values.push(input.completed ? 1 : 0); }
  const clause = where.join(" AND ");

  const total = database.prepare(`SELECT COUNT(*) AS count FROM challenges WHERE ${clause}`).get(...values) as { count: number };
  const rows = database.prepare(`SELECT scope, name, joined_at AS joinedAt, completed FROM challenges WHERE ${clause} ORDER BY joined_at DESC, name ASC LIMIT ? OFFSET ?`)
    .all(...values, pageSize, (page - 1) * pageSize) as { scope: string; name: string; joinedAt: string | null; completed: number | null }[];
  const counts = database.prepare("SELECT scope, COUNT(*) AS total, SUM(completed = 1) AS completed FROM challenges WHERE observation_status = 'observed' GROUP BY scope").all();

  return {
    challenges: rows.map((row) => ({ ...row, completed: row.completed === null ? null : row.completed === 1 })),
    pagination: { page, pageSize, total: total.count, hasMore: page * pageSize < total.count },
    countsByScope: counts,
    definitions: {
      scope: "global is a Strava-wide challenge; group is an invite-only group challenge.",
      completed: "Source-supplied completion flag. Null means the export did not state it.",
    },
  };
}

export function getClubs(database: Database, input: { page?: number | undefined; pageSize?: number | undefined }): object {
  const page = input.page ?? 1; const pageSize = input.pageSize ?? 25;
  const total = database.prepare("SELECT COUNT(*) AS count FROM clubs WHERE observation_status = 'observed'").get() as { count: number };
  const rows = database.prepare(`
    SELECT c.name, c.description, c.club_type AS clubType, c.sport, c.city, c.state, c.country, c.website, c.source,
      m.joined_at AS joinedAt, m.club_id IS NOT NULL AS isMember
    FROM clubs c LEFT JOIN club_memberships m ON m.club_id = c.id AND m.observation_status = 'observed'
    WHERE c.observation_status = 'observed' ORDER BY c.name LIMIT ? OFFSET ?
  `).all(pageSize, (page - 1) * pageSize) as Record<string, unknown>[];

  return {
    clubs: rows.map((row) => ({ ...row, isMember: row.isMember === 1 })),
    pagination: { page, pageSize, total: total.count, hasMore: page * pageSize < total.count },
    definitions: {
      source: "club-file means clubs.csv described the club; membership-only means a membership named it and clubs.csv did not, so only its name is known.",
    },
  };
}
