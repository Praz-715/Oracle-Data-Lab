import type { ColumnKind, ColumnProfile } from '../../shared/types/lab'

// Column profiling and Oracle type inference for imported files. Pure functions only: the reader
// feeds every value of a column into a ColumnStats, which decides the narrowest Oracle type that
// holds all of them. Values stay strings end to end; conversion happens in Oracle (TO_NUMBER /
// TO_DATE with an explicit mask), so precision and dates are never mangled by JavaScript.

const DISTINCT_CAP = 150_000
const SAMPLE_COUNT = 5

/** Oracle reserved words (and a few keywords that make awkward column names). */
const RESERVED = new Set(
  'ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BETWEEN BY CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DEFAULT DELETE DESC DISTINCT DROP ELSE EXCLUSIVE EXISTS FILE FLOAT FOR FROM GRANT GROUP HAVING IDENTIFIED IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PCTFREE PRIOR PUBLIC RAW RENAME RESOURCE REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHERE WITH TIMESTAMP TYPE'.split(' '),
)

/** Turns a header or file name into a valid, unquoted Oracle identifier. */
export function oracleName(raw: string, used?: Set<string>, maxLen = 30, fallback = 'COL'): string {
  let n = raw
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
  if (!n) n = fallback
  if (!/^[A-Z]/.test(n)) n = `C_${n}`
  n = n.slice(0, maxLen).replace(/_+$/, '')
  if (RESERVED.has(n)) n = `${n.slice(0, maxLen - 1)}_`
  if (used) {
    let k = n
    for (let i = 2; used.has(k); i++) k = `${n.slice(0, maxLen - String(i).length - 1)}_${i}`
    used.add(k)
    n = k
  }
  return n
}

/** Table name suggestion from a file name: olist_orders_dataset.csv -> OLIST_ORDERS_DATASET. */
export function tableNameFromFile(file: string): string {
  return oracleName(file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, ''), undefined, 30, 'IMPORTED')
}

// ---------------------------------------------------------------------------------------------
// Date families: one regex per family with optional time; the mask is built from what was seen.
// ---------------------------------------------------------------------------------------------

interface DateFamily {
  id: string
  re: RegExp
  /** Group indices of y, m, d. */
  ymd: [number, number, number]
  datePart: (sep: string) => string
}

const TIME = String.raw`(?:([ T])(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?`
const FAMILIES: DateFamily[] = [
  { id: 'ymd', re: new RegExp(String.raw`^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})${TIME}$`), ymd: [1, 3, 4], datePart: (s) => `YYYY${s}MM${s}DD` },
  { id: 'dmy', re: new RegExp(String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})${TIME}$`), ymd: [4, 3, 1], datePart: (s) => `DD${s}MM${s}YYYY` },
  { id: 'mdy', re: new RegExp(String.raw`^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})${TIME}$`), ymd: [4, 1, 3], datePart: (s) => `MM${s}DD${s}YYYY` },
]

interface FamilyState {
  alive: boolean
  sep: string | null
  timeSep: string | null
  anyTime: boolean
  anySeconds: boolean
  frac: number
}

function matchDate(f: DateFamily, st: FamilyState, v: string): boolean {
  const m = f.re.exec(v)
  if (!m) return false
  const y = Number(m[f.ymd[0]])
  const mo = Number(m[f.ymd[1]])
  const d = Number(m[f.ymd[2]])
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1 || y > 9999) return false
  if (st.sep != null && st.sep !== m[2]) return false
  // Groups after the date: 5 = time separator, 6 = hour, 7 = minute, 8 = second, 9 = fraction.
  if (m[5] != null) {
    const h = Number(m[6])
    const mi = Number(m[7])
    const s = m[8] != null ? Number(m[8]) : 0
    if (h > 23 || mi > 59 || s > 59) return false
    if (st.timeSep != null && st.timeSep !== m[5]) return false
    st.timeSep = m[5]
    st.anyTime = true
    if (m[8] != null) st.anySeconds = true
    if (m[9] != null) st.frac = Math.max(st.frac, m[9].length)
  }
  st.sep = m[2]!
  return true
}

/** Sortable key for a date value of a family (for min/max). */
function dateKey(f: DateFamily, v: string): string {
  const m = f.re.exec(v)!
  const p = (x: string | undefined, n = 2) => (x ?? '0').padStart(n, '0')
  return `${p(m[f.ymd[0]], 4)}${p(m[f.ymd[1]])}${p(m[f.ymd[2]])}${p(m[6])}${p(m[7])}${p(m[8])}${(m[9] ?? '').padEnd(9, '0')}`
}

const INT_RE = /^[+-]?\d+$/
const DEC_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?$/
const DEC_COMMA_RE = /^[+-]?(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d+)?$/
const VARCHAR_STEPS = [1, 2, 3, 5, 10, 20, 30, 50, 80, 100, 150, 200, 255, 300, 500, 1000, 2000, 4000]

/** Normalizes a decimal-comma number (1.234,56) to Oracle's canonical form (1234.56). */
export function normalizeDecimalComma(v: string): string {
  return v.replace(/\./g, '').replace(',', '.')
}

export class ColumnStats {
  readonly index: number
  readonly header: string
  nonNull = 0
  nulls = 0
  private minLen = Infinity
  private maxLen = 0
  private maxBytes = 0
  private distinct = new Set<string>()
  private capped = false
  private samples: string[] = []
  // numeric
  private allInt = true
  private allDec = true
  private allDecComma = true
  private anyComma = false
  private leadingZero = false
  private intDigits = 0
  private scale = 0
  private numMin = Infinity
  private numMax = -Infinity
  // text
  private strMin: string | null = null
  private strMax: string | null = null
  // dates
  private fam: FamilyState[] = FAMILIES.map(() => ({ alive: true, sep: null, timeSep: null, anyTime: false, anySeconds: false, frac: 0 }))
  private dateMin: ([string, string] | null)[] = FAMILIES.map(() => null)
  private dateMax: ([string, string] | null)[] = FAMILIES.map(() => null)

  constructor(index: number, header: string) {
    this.index = index
    this.header = header
  }

  add(raw: string | null | undefined) {
    const v = raw == null ? '' : raw.trim()
    if (v === '') {
      this.nulls++
      return
    }
    this.nonNull++
    const len = v.length
    if (len < this.minLen) this.minLen = len
    if (len > this.maxLen) this.maxLen = len
    const bytes = Buffer.byteLength(v, 'utf8')
    if (bytes > this.maxBytes) this.maxBytes = bytes
    if (!this.capped) {
      if (this.distinct.size < DISTINCT_CAP) this.distinct.add(v)
      else if (!this.distinct.has(v)) this.capped = true
    }
    if (this.samples.length < SAMPLE_COUNT && !this.samples.includes(v)) this.samples.push(v)
    if (this.strMin == null || v < this.strMin) this.strMin = v
    if (this.strMax == null || v > this.strMax) this.strMax = v

    if (this.allInt || this.allDec || this.allDecComma) this.addNumber(v)
    this.fam.forEach((st, i) => {
      if (!st.alive) return
      const f = FAMILIES[i]!
      if (!matchDate(f, st, v)) {
        st.alive = false
        return
      }
      const k = dateKey(f, v)
      const lo = this.dateMin[i]
      const hi = this.dateMax[i]
      if (!lo || k < lo[0]) this.dateMin[i] = [k, v]
      if (!hi || k > hi[0]) this.dateMax[i] = [k, v]
    })
  }

  private addNumber(v: string) {
    const unsigned = v.replace(/^[+-]/, '')
    if (this.allInt && !INT_RE.test(v)) this.allInt = false
    if (this.allDec && !DEC_RE.test(v)) this.allDec = false
    if (this.allDecComma && !DEC_COMMA_RE.test(v)) this.allDecComma = false
    if (v.includes(',')) this.anyComma = true
    if (INT_RE.test(v) && unsigned.length > 1 && unsigned.startsWith('0')) this.leadingZero = true
    let canonical: string | null = null
    if (DEC_RE.test(v)) canonical = v
    else if (DEC_COMMA_RE.test(v)) canonical = normalizeDecimalComma(v)
    if (canonical == null) return
    const n = Number(canonical)
    if (Number.isFinite(n)) {
      if (n < this.numMin) this.numMin = n
      if (n > this.numMax) this.numMax = n
    }
    const plain = canonical.replace(/^[+-]/, '').replace(/[eE].*$/, '')
    const [i = '', f = ''] = plain.split('.')
    this.intDigits = Math.max(this.intDigits, i.replace(/^0+(?=\d)/, '').length)
    this.scale = Math.max(this.scale, f.length)
  }

  private textType(): string {
    if (this.maxBytes > 4000) return 'CLOB'
    if (this.nonNull && this.minLen === this.maxLen) return `VARCHAR2(${this.maxLen} CHAR)`
    const want = Math.ceil(this.maxLen * 1.1)
    return `VARCHAR2(${VARCHAR_STEPS.find((s) => s >= want) ?? 4000} CHAR)`
  }

  finish(name: string): ColumnProfile {
    let kind: ColumnKind = 'text'
    let oracleType: string
    let dateMask: string | null = null
    let decimalComma = false
    let keepAsText = false
    let min: string | null = this.strMin
    let max: string | null = this.strMax
    const numeric = this.allInt || this.allDec || (this.allDecComma && this.anyComma)

    if (!this.nonNull) {
      kind = 'empty'
      oracleType = 'VARCHAR2(100 CHAR)'
    } else if (numeric && (this.leadingZero || this.intDigits > 38)) {
      // Codes such as zip prefixes ("01037") or long digit ids must not lose characters.
      keepAsText = true
      oracleType = this.textType()
    } else if (this.allInt) {
      kind = 'integer'
      oracleType = `NUMBER(${Math.min(38, Math.max(this.intDigits + 2, 3))})`
      min = String(this.numMin)
      max = String(this.numMax)
    } else if (this.allDec || (this.allDecComma && this.anyComma)) {
      kind = 'decimal'
      decimalComma = !this.allDec
      const s = Math.min(this.scale, 30)
      oracleType = `NUMBER(${Math.min(38, this.intDigits + s + 2)},${s})`
      min = String(this.numMin)
      max = String(this.numMax)
    } else {
      const fi = this.fam.findIndex((f) => f.alive)
      if (fi >= 0) {
        const st = this.fam[fi]!
        const f = FAMILIES[fi]!
        dateMask = f.datePart(st.sep ?? '-')
        if (st.anyTime) dateMask += `${st.timeSep === 'T' ? '"T"' : ' '}HH24:MI${st.anySeconds ? ':SS' : ''}${st.frac ? '.FF' : ''}`
        kind = st.anyTime ? 'timestamp' : 'date'
        oracleType = st.frac ? `TIMESTAMP(${Math.min(st.frac, 9)})` : 'DATE'
        min = this.dateMin[fi]?.[1] ?? null
        max = this.dateMax[fi]?.[1] ?? null
      } else {
        oracleType = this.textType()
      }
    }

    return {
      index: this.index,
      header: this.header,
      name,
      kind,
      oracleType,
      dateMask,
      decimalComma,
      nonNull: this.nonNull,
      nulls: this.nulls,
      distinct: this.distinct.size,
      distinctCapped: this.capped,
      maxLength: this.maxLen,
      maxBytes: this.maxBytes,
      min,
      max,
      samples: this.samples,
      keepAsText,
      unique: !this.capped && this.nonNull > 0 && this.distinct.size === this.nonNull && this.nulls === 0,
    }
  }
}

/** Profiles rows that are already split into cells. Header row handling is up to the caller. */
export function profileColumns(headers: string[], rows: Iterable<(string | null)[]>): ColumnProfile[] {
  const stats = headers.map((h, i) => new ColumnStats(i, h))
  for (const r of rows) {
    for (let i = 0; i < stats.length; i++) stats[i]!.add(r[i])
  }
  const used = new Set<string>()
  return stats.map((s) => s.finish(oracleName(s.header, used)))
}
