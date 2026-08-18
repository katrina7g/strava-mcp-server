import type { Database } from "./database.js";

/**
 * A grouped query over a long history can return thousands of rows — day
 * grouping across a decade is well over three thousand — which is not a
 * suitable MCP response. Results are capped and the cap is disclosed, so a
 * client can tell a complete answer from a truncated one rather than
 * silently reasoning over a partial series.
 */
export const DEFAULT_MAX_GROUPS = 366;
export const MAX_GROUPS = 1_000;

export type BoundedGroups = {
  groups: unknown[];
  totalGroups: number;
  truncated: boolean;
  maxGroups: number;
};

export function boundedGroups(database: Database, groupedSql: string, values: readonly unknown[], maxGroups: number): BoundedGroups {
  const limit = Math.min(Math.max(1, maxGroups), MAX_GROUPS);
  const total = database.prepare(`SELECT COUNT(*) AS count FROM (${groupedSql})`).get(...values) as { count: number };
  const groups = database.prepare(`${groupedSql} LIMIT ?`).all(...values, limit);
  return { groups, totalGroups: total.count, truncated: total.count > limit, maxGroups: limit };
}
