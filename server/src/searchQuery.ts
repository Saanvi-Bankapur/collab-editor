/**
 * Turns what the user typed into a tsquery.
 *  - plain words -> prefix search on every word ("coll edit" matches "collaborative editor"), good while typing
 *  - quotes, OR, or -word -> Postgres' web-search syntax (websearch_to_tsquery)
 */
export function buildTsQuery(q: string): { sql: string; param: string } | null {
  const trimmed = q.trim().slice(0, 200)
  if (!trimmed) return null
  if (/["]|\sOR\s|(^|\s)-\S/.test(trimmed)) {
    return { sql: "websearch_to_tsquery('english', $2)", param: trimmed }
  }
  const words = trimmed.match(/[\p{L}\p{N}]+/gu)
  if (!words?.length) return null
  return { sql: "to_tsquery('english', $2)", param: words.slice(0, 12).map((w) => `${w}:*`).join(' & ') }
}

