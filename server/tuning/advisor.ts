import type { AdvisorNote, IndexCandidate, PredicateKind } from '../../shared/types/lab'

// Index advisor heuristics (no Tuning Pack): read the predicates Oracle prints in PLAN_TABLE,
// classify how each column is used, and propose B-tree indexes only where they can help —
// selective filters on large full-scanned tables, or join columns of a big table probed by a small
// row source. Predicates that defeat indexes (functions, implicit conversions, leading wildcards)
// become notes instead. Pure functions: the service feeds plan rows and dictionary statistics.

export interface PlanRow {
  id: number
  parentId: number | null
  operation: string
  options: string | null
  owner: string | null
  object: string | null
  /** PLAN_TABLE.OBJECT_ALIAS, e.g. "O@SEL$1". */
  alias: string | null
  cost: number | null
  cardinality: number | null
  access: string | null
  filter: string | null
}

export interface TableInfo {
  owner: string
  table: string
  rows: number | null
  ndv: Record<string, number | null>
  indexes: { name: string; columns: string[] }[]
}

export interface ColumnUse {
  column: string
  kind: PredicateKind
  fn?: string
  text: string
}

const MIN_ROWS = 10_000
const MAX_SELECTIVITY = 0.1

/** Splits a predicate on top-level AND (outside parentheses and string literals). */
export function splitConjuncts(pred: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let start = 0
  for (let i = 0; i < pred.length; i++) {
    const ch = pred[i]
    if (ch === "'") quote = !quote
    else if (quote) continue
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && pred.startsWith(' AND ', i)) {
      out.push(pred.slice(start, i).trim())
      start = i + 5
      i += 4
    }
  }
  out.push(pred.slice(start).trim())
  return out.filter(Boolean).map(unwrap)
}

function splitTop(pred: string, word: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = false
  let start = 0
  const sep = ` ${word} `
  for (let i = 0; i < pred.length; i++) {
    const ch = pred[i]
    if (ch === "'") quote = !quote
    else if (quote) continue
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (depth === 0 && pred.startsWith(sep, i)) {
      out.push(pred.slice(start, i).trim())
      start = i + sep.length
      i += sep.length - 1
    }
  }
  out.push(pred.slice(start).trim())
  return out.map(unwrap)
}

/** Removes parentheses that wrap the whole expression. */
function unwrap(s: string): string {
  let t = s.trim()
  while (t.startsWith('(') && t.endsWith(')')) {
    let depth = 0
    let wraps = true
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '(') depth++
      else if (t[i] === ')') depth--
      if (depth === 0 && i < t.length - 1) {
        wraps = false
        break
      }
    }
    if (!wraps) break
    t = t.slice(1, -1).trim()
  }
  return t
}

const REF = /(?:"([A-Z0-9_$#]+)"\.)?"([A-Z0-9_$#]+)"/g

export function aliasOf(objectAlias: string | null, table: string | null): string | null {
  if (objectAlias) return objectAlias.replace(/^"|"$/g, '').split('@')[0]!.replace(/"/g, '')
  return table
}

/** How the columns of `alias` (or unqualified columns) are used in one conjunct. */
export function classify(conjunct: string, alias: string | null): ColumnUse[] {
  // OR of equalities on one column == IN-list.
  const ors = splitTop(conjunct, 'OR')
  if (ors.length > 1) {
    const parts = ors.map((p) => classify(p, alias))
    const cols = new Set(parts.flat().map((u) => u.column))
    if (parts.every((p) => p.length === 1 && p[0]!.kind === 'eq') && cols.size === 1) return [{ column: [...cols][0]!, kind: 'in', text: conjunct }]
    return []
  }
  const refs = [...conjunct.matchAll(REF)].map((m) => ({ q: m[1] ?? null, col: m[2]!, at: m.index!, end: m.index! + m[0].length }))
  const mine = refs.filter((r) => r.q === null || r.q === alias)
  const others = refs.filter((r) => r.q !== null && r.q !== alias)
  const out: ColumnUse[] = []
  for (const r of mine) {
    const before = conjunct.slice(0, r.at)
    let after = conjunct.slice(r.end)
    // Chain of functions wrapping the column, e.g. TRUNC(INTERNAL_FUNCTION("O"."TS")): report the
    // outermost real function; INTERNAL_FUNCTION alone means an implicit datatype conversion.
    const chain = /((?:[A-Z_][A-Z0-9_$#]*\(\s*)+)$/.exec(before)?.[1]
    if (chain) {
      const fns = [...chain.matchAll(/([A-Z_][A-Z0-9_$#]*)\(/g)].map((m) => m[1]!)
      const real = fns.find((f) => f !== 'INTERNAL_FUNCTION')
      out.push({ column: r.col, kind: real ? 'function' : 'implicit', fn: real ?? 'INTERNAL_FUNCTION', text: conjunct })
      continue
    }
    after = after.trimStart()
    const op = /^(NOT LIKE|LIKE|IS NOT NULL|IS NULL|<>|!=|>=|<=|=|>|<)/.exec(after)?.[1] ?? /(>=|<=|<>|!=|=|>|<)\s*$/.exec(before)?.[1] ?? null
    if (!op) continue
    if (op === '=' && others.length) {
      out.push({ column: r.col, kind: 'join', text: conjunct })
      continue
    }
    if (op === '=') out.push({ column: r.col, kind: 'eq', text: conjunct })
    else if (['>', '<', '>=', '<='].includes(op)) out.push({ column: r.col, kind: 'range', text: conjunct })
    else if (op === 'LIKE') {
      const lit = /^LIKE\s*'([^']*)'/.exec(after)?.[1]
      out.push({ column: r.col, kind: lit != null && /^[%_]/.test(lit) ? 'like-wild' : 'like-prefix', text: conjunct })
    } else if (op === 'IS NULL') out.push({ column: r.col, kind: 'null', text: conjunct })
    else out.push({ column: r.col, kind: 'neq', text: conjunct })
  }
  return out
}

export function uses(pred: string | null, alias: string | null): ColumnUse[] {
  if (!pred) return []
  return splitConjuncts(pred).flatMap((c) => classify(c, alias))
}

const INDEXABLE: PredicateKind[] = ['eq', 'in', 'range', 'like-prefix']
const shortName = (base: string, suffix: string, max = 30) => `${base.slice(0, max - suffix.length).replace(/_+$/, '')}${suffix}`

/** The index (if any) whose leading columns are exactly `cols` in any order. */
function covering(info: TableInfo | undefined, lead: string[]): string | null {
  if (!info || !lead.length) return null
  const want = new Set(lead)
  for (const ix of info.indexes) {
    const head = new Set(ix.columns.slice(0, lead.length))
    if (head.size === want.size && [...want].every((c) => head.has(c))) return ix.name
  }
  return null
}

function pctText(v: number) {
  return v < 0.001 ? '<0.1%' : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`
}

export function buildAdvice(plan: PlanRow[], tables: Map<string, TableInfo>) {
  const candidates: IndexCandidate[] = []
  const notes: AdvisorNote[] = []
  const fullScans: { owner: string; table: string; tableRows: number | null; estRows: number | null; cost: number | null }[] = []
  const seen = new Set<string>()
  const noteOnce = (n: AdvisorNote) => {
    const k = `${n.table}|${n.text}`
    if (!seen.has(k)) {
      seen.add(k)
      notes.push(n)
    }
  }
  const key = (o: string, t: string) => `${o}.${t}`

  // Predicates that defeat indexes, wherever they appear.
  for (const r of plan) {
    if (!r.object || !r.owner) continue
    const alias = aliasOf(r.alias, r.object)
    for (const u of [...uses(r.filter, alias), ...uses(r.access, alias)]) {
      const where = `${r.owner}.${r.object}.${u.column}`
      if (u.kind === 'implicit') noteOnce({ severity: 'warning', table: `${r.owner}.${r.object}`, text: `Implicit datatype conversion on ${where} (INTERNAL_FUNCTION): the column is converted row by row, so an index on it cannot be used. Compare it with a value of the column's own type.` })
      if (u.kind === 'function') noteOnce({ severity: 'warning', table: `${r.owner}.${r.object}`, text: `${u.fn}(${u.column}) on ${r.owner}.${r.object}: a normal index on ${u.column} cannot be used. Rewrite the predicate on the bare column (e.g. a date range instead of TRUNC) or create a function-based index on ${u.fn}(${u.column}).` })
      if (u.kind === 'like-wild') noteOnce({ severity: 'info', table: `${r.owner}.${r.object}`, text: `LIKE with a leading wildcard on ${where}: a B-tree index cannot seek it. For text search consider Oracle Text (CONTEXT index).` })
    }
  }

  for (const r of plan) {
    if (r.operation !== 'TABLE ACCESS' || !/FULL/.test(r.options ?? '') || !r.object || !r.owner) continue
    const info = tables.get(key(r.owner, r.object))
    const rows = info?.rows ?? null
    fullScans.push({ owner: r.owner, table: r.object, tableRows: rows, estRows: r.cardinality, cost: r.cost })
    const alias = aliasOf(r.alias, r.object)
    const all = uses(r.filter, alias)
    const us = all.filter((u) => INDEXABLE.includes(u.kind))
    if (!us.length) continue
    if (rows != null && rows < MIN_ROWS) {
      noteOnce({ severity: 'info', table: key(r.owner, r.object), text: `${r.object} has only ${rows.toLocaleString()} rows — a full scan is fine.` })
      continue
    }
    const ndv = (c: string) => info?.ndv[c] ?? null
    // The plan cardinality covers the whole filter. When non-indexable predicates also filter this
    // table, the index would only apply the indexable part: estimate that from column NDVs instead.
    const eqUses = us.filter((u) => u.kind === 'eq' || u.kind === 'in')
    const mixed = all.some((u) => !INDEXABLE.includes(u.kind))
    let sel = rows && r.cardinality != null ? Math.min(1, r.cardinality / rows) : null
    if (mixed && eqUses.length) {
      const ndvSel = eqUses.reduce((p, u) => p * (ndv(u.column) ? 1 / ndv(u.column)! : 1), 1)
      sel = Math.max(sel ?? 0, ndvSel)
    }
    if (sel != null && sel > MAX_SELECTIVITY) {
      noteOnce({ severity: 'info', table: key(r.owner, r.object), text: `The indexable part of the filter on ${r.object} keeps ~${pctText(sel)} of ${rows!.toLocaleString()} rows — reading that much through an index is usually slower than the full scan.` })
      continue
    }
    const eqCols = [...new Set(us.filter((u) => u.kind === 'eq' || u.kind === 'in').map((u) => u.column))].sort((a, b) => (ndv(b) ?? -1) - (ndv(a) ?? -1))
    const rangeCol = us.filter((u) => u.kind === 'range' || u.kind === 'like-prefix').map((u) => u.column).filter((c) => !eqCols.includes(c)).sort((a, b) => (ndv(b) ?? -1) - (ndv(a) ?? -1))[0]
    const cols = [...eqCols, ...(rangeCol ? [rangeCol] : [])].slice(0, 4)
    const lead = eqCols.length ? eqCols : cols.slice(0, 1)
    const covered = covering(info, lead)
    const name = shortName(r.object, `_${cols[0]!.slice(0, 8)}_IX`)
    candidates.push({
      id: `${key(r.owner, r.object)}(${cols.join(',')})`,
      owner: r.owner,
      table: r.object,
      columns: cols,
      kind: 'filter',
      rationale: covered
        ? `Index ${covered} already starts with ${lead.join(', ')} but the optimizer chose a full scan — check statistics, bind peeking or data skew before adding another index.`
        : `Full scan of ${r.object}${rows != null ? ` (${rows.toLocaleString()} rows)` : ''} keeps ${sel != null ? `~${pctText(sel)}` : 'an unknown share'} of the rows. ` +
          `Equality columns first${eqCols.length ? ` (${eqCols.join(', ')})` : ''}${rangeCol ? `, then the range column ${rangeCol}` : ''}.`,
      selectivity: sel,
      tableRows: rows,
      estRows: r.cardinality,
      coveredBy: covered,
      ddl: `CREATE INDEX ${r.owner}.${name} ON ${r.owner}.${r.object} (${cols.join(', ')})`,
      score: Math.round((r.cost ?? 1) * (1 - (sel ?? 0.5))),
    })
  }

  // Joins: a big table read in full only to be probed by a small row source → index on its join column.
  const byId = new Map(plan.map((r) => [r.id, r]))
  for (const j of plan) {
    if (!/^HASH JOIN|^MERGE JOIN/.test(j.operation) || !j.access) continue
    const kids = plan.filter((r) => r.parentId === j.id).sort((a, b) => a.id - b.id)
    if (kids.length !== 2) continue
    const [build, probe] = kids as [PlanRow, PlanRow]
    const scan = probe.operation === 'TABLE ACCESS' && /FULL/.test(probe.options ?? '') ? probe : null
    if (!scan?.object || !scan.owner) continue
    const info = tables.get(key(scan.owner, scan.object))
    const rows = info?.rows ?? null
    const drive = build.cardinality ?? byId.get(build.id)?.cardinality ?? null
    if (rows == null || rows < 100_000 || drive == null || drive > Math.min(5000, rows * 0.01)) continue
    const alias = aliasOf(scan.alias, scan.object)
    const jcol = uses(j.access, alias).find((u) => u.kind === 'join')?.column
    if (!jcol) continue
    const covered = covering(info, [jcol])
    const id = `${key(scan.owner, scan.object)}(${jcol})`
    if (candidates.some((c) => c.id === id)) continue
    candidates.push({
      id,
      owner: scan.owner,
      table: scan.object,
      columns: [jcol],
      kind: 'join',
      rationale: covered
        ? `Index ${covered} on ${jcol} exists, yet all ${rows.toLocaleString()} rows of ${scan.object} are read for ~${drive.toLocaleString()} driving rows — check statistics on the driving side.`
        : `All ${rows.toLocaleString()} rows of ${scan.object} are read to join ~${drive.toLocaleString()} rows; an index on ${jcol} lets Oracle use a nested-loop lookup instead.`,
      selectivity: drive / rows,
      tableRows: rows,
      estRows: drive,
      coveredBy: covered,
      ddl: `CREATE INDEX ${scan.owner}.${shortName(scan.object, `_${jcol.slice(0, 8)}_IX`)} ON ${scan.owner}.${scan.object} (${jcol})`,
      score: Math.round((scan.cost ?? 1) * 0.9),
    })
  }

  candidates.sort((a, b) => Number(!!a.coveredBy) - Number(!!b.coveredBy) || b.score - a.score)
  return { candidates, notes, fullScans }
}
