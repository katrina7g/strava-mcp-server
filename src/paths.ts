import { isAbsolute, relative, sep } from "node:path";

/**
 * True when `candidate` is `root` itself or lies strictly inside it. Both the
 * validator and the detailed-format decoder need this same containment check
 * against source-supplied paths, so it lives in one place rather than two.
 */
export function withinRoot(root: string, candidate: string): boolean {
  const difference = relative(root, candidate);
  return difference === "" || (!difference.startsWith(`..${sep}`) && difference !== ".." && !isAbsolute(difference));
}
