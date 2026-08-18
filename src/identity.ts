/**
 * The export identifies gear only by free text: the catalog's `Activity Gear`
 * column holds a name that must be matched back to a gear-file row. Case and
 * whitespace differ between those sources, so both sides are normalized
 * through this one function. Punctuation is preserved because model names
 * depend on it.
 *
 * This lives apart from the catalog and gear modules so both can depend on it
 * without importing each other.
 */
export function normalizeMatchKey(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}
