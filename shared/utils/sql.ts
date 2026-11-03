/** Bind variable names in order of appearance (string literals, comments and q-quotes ignored). */
export function bindNames(sql: string): string[] {
  const stripped = sql
    .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ')
    .replace(/q'\[[\s\S]*?\]'|q'\{[\s\S]*?\}'|q'\([\s\S]*?\)'|q'<[\s\S]*?>'/gi, "''")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"])*"/g, '""')
  const out: string[] = []
  for (const m of stripped.matchAll(/(?<![:\w]):([A-Za-z][A-Za-z0-9_$#]*)/g)) if (!out.some((n) => n.toUpperCase() === m[1]!.toUpperCase())) out.push(m[1]!)
  return out
}
