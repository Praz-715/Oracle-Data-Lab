import { StringDecoder } from 'node:string_decoder'
import { createError } from 'h3'
import { SaxesParser } from 'saxes'
import unzipper from 'unzipper'

// Minimal streaming XLSX reader: zip central directory (random access, no assumptions about entry
// order) + SAX parsing of the sheet XML. It yields cell text per row; date-formatted numbers become
// 'YYYY-MM-DD[ HH:MM:SS]'. Shared strings are held in memory (they are usually small); rows never are.

type Directory = Awaited<ReturnType<typeof unzipper.Open.file>>
type Entry = Directory['files'][number]

interface WorkbookInfo {
  dir: Directory
  sheets: { name: string; path: string }[]
  date1904: boolean
}

function decodeXml(s: string) {
  return s.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e: string) => {
    const k = e.toLowerCase()
    if (k === 'amp') return '&'
    if (k === 'lt') return '<'
    if (k === 'gt') return '>'
    if (k === 'quot') return '"'
    if (k === 'apos') return "'"
    return String.fromCodePoint(k.startsWith('#x') ? Number.parseInt(k.slice(2), 16) : Number(k.slice(1)))
  })
}

async function text(entry: Entry | undefined) {
  return entry ? (await entry.buffer()).toString('utf8') : null
}

function attr(tag: string, name: string) {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)
  return m ? decodeXml(m[1]!) : null
}

async function openWorkbook(file: string): Promise<WorkbookInfo> {
  const dir = await unzipper.Open.file(file)
  const find = (p: string) => dir.files.find((f) => f.path.replace(/^\//, '') === p)
  const wb = await text(find('xl/workbook.xml'))
  if (wb == null) throw createError({ statusCode: 400, statusMessage: 'Not a valid .xlsx workbook (xl/workbook.xml missing).' })
  const rels = (await text(find('xl/_rels/workbook.xml.rels'))) ?? ''
  const target = new Map<string, string>()
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], 'Id')
    const t = attr(m[0], 'Target')
    if (id && t) target.set(id, t.startsWith('/') ? t.slice(1) : `xl/${t}`)
  }
  const sheets: WorkbookInfo['sheets'] = []
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(m[0], 'name')
    const rid = attr(m[0], 'r:id') ?? attr(m[0], 'id')
    const path = rid ? target.get(rid) : undefined
    if (name && path) sheets.push({ name, path: path.replace(/\/\.\//g, '/') })
  }
  return { dir, sheets, date1904: /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(wb) }
}

export async function listSheets(file: string): Promise<string[]> {
  return (await openWorkbook(file)).sheets.map((s) => s.name)
}

/** Runs a SAX parser over a zip entry, yielding whatever the handlers pushed after each chunk. */
async function* saxStream<T>(entry: Entry, setup: (p: SaxesParser, out: T[]) => void): AsyncGenerator<T> {
  const parser = new SaxesParser()
  const out: T[] = []
  setup(parser, out)
  const decoder = new StringDecoder('utf8')
  const stream = entry.stream()
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      parser.write(decoder.write(chunk))
      while (out.length) yield out.shift()!
    }
    parser.write(decoder.end())
    parser.close()
    while (out.length) yield out.shift()!
  } finally {
    stream.destroy()
  }
}

async function sharedStrings(info: WorkbookInfo): Promise<string[]> {
  const entry = info.dir.files.find((f) => f.path === 'xl/sharedStrings.xml')
  if (!entry) return []
  const all: string[] = []
  // <si> holds either <t> or rich runs <r><t/></r>; phonetic hints (<rPh>) are skipped.
  for await (const s of saxStream<string>(entry, (p, out) => {
    let cur: string[] | null = null
    let inT = false
    let skip = 0
    p.on('opentag', (t) => {
      if (t.name === 'si') cur = []
      else if (t.name === 'rPh') skip++
      else if (t.name === 't' && !skip) inT = true
    })
    p.on('text', (v) => {
      if (inT && cur) cur.push(v)
    })
    p.on('closetag', (t) => {
      if (t.name === 't') inT = false
      else if (t.name === 'rPh') skip--
      else if (t.name === 'si') {
        out.push(cur!.join(''))
        cur = null
      }
    })
  })) {
    all.push(s)
  }
  return all
}

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58])

/** True when an Excel number format code renders a date/time. */
export function isDateFormat(code: string): boolean {
  const s = code
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .replace(/_.|\*./g, '')
  return /[dmyhs]/i.test(s) && !/^General$/i.test(s.trim())
}

/** Style index -> is a date format, from xl/styles.xml. */
async function dateStyles(info: WorkbookInfo): Promise<boolean[]> {
  const xml = await text(info.dir.files.find((f) => f.path === 'xl/styles.xml'))
  if (!xml) return []
  const custom = new Map<number, string>()
  for (const m of xml.matchAll(/<numFmt\b[^>]*>/g)) {
    const id = Number(attr(m[0], 'numFmtId'))
    const code = attr(m[0], 'formatCode')
    if (code != null) custom.set(id, code)
  }
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? ''
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(attr(m[0], 'numFmtId') ?? 0)
    return custom.has(id) ? isDateFormat(custom.get(id)!) : BUILTIN_DATE_FMTS.has(id)
  })
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')

/** Excel serial date -> 'YYYY-MM-DD' or 'YYYY-MM-DD HH:MM:SS' (wall clock, no zone). */
export function serialToText(serial: number, date1904 = false): string {
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30)
  const d = new Date(base + Math.round(serial * 86400) * 1000)
  const day = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  if (!d.getUTCHours() && !d.getUTCMinutes() && !d.getUTCSeconds()) return day
  return `${day} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

/** Column letters of a cell reference (B12 -> 1). */
function colIndex(ref: string): number {
  let n = 0
  for (const ch of ref) {
    const c = ch.charCodeAt(0)
    if (c < 65 || c > 90) break
    n = n * 26 + (c - 64)
  }
  return n - 1
}

/** Yields the rows of one sheet (first sheet when `sheet` is empty); empty rows are skipped. */
export async function* readXlsxRows(file: string, sheet?: string | null, signal?: AbortSignal): AsyncGenerator<(string | null)[]> {
  const info = await openWorkbook(file)
  const target = sheet ? info.sheets.find((s) => s.name === sheet) : info.sheets[0]
  if (!target) throw createError({ statusCode: 400, statusMessage: sheet ? `Sheet "${sheet}" not found in the workbook.` : 'The workbook has no sheets.' })
  const entry = info.dir.files.find((f) => f.path === target.path)
  if (!entry) throw createError({ statusCode: 400, statusMessage: `Sheet "${target.name}" data is missing (${target.path}).` })
  const strings = await sharedStrings(info)
  const dates = await dateStyles(info)

  for await (const row of saxStream<(string | null)[]>(entry, (p, out) => {
    let cells: (string | null)[] | null = null
    let col = 0
    let type = 'n'
    let style = 0
    let val: string[] = []
    let inV = false
    let inT = false
    p.on('opentag', (t) => {
      const a = t.attributes as Record<string, string>
      switch (t.name) {
        case 'row':
          cells = []
          col = 0
          break
        case 'c':
          col = a.r ? colIndex(a.r) : col
          type = a.t ?? 'n'
          style = Number(a.s ?? 0)
          val = []
          break
        case 'v':
          inV = true
          break
        case 't':
          inT = type === 'inlineStr'
          break
      }
    })
    p.on('text', (v) => {
      if (inV || inT) val.push(v)
    })
    p.on('closetag', (t) => {
      switch (t.name) {
        case 'v':
          inV = false
          break
        case 't':
          inT = false
          break
        case 'c': {
          const raw = val.join('')
          let out: string | null = raw === '' ? null : raw
          if (out != null) {
            if (type === 's') out = strings[Number(out)] ?? null
            else if (type === 'b') out = out === '1' ? 'TRUE' : 'FALSE'
            else if (type === 'e') out = null
            else if ((type === 'n' || type === 'd') && dates[style] && Number.isFinite(Number(out))) out = serialToText(Number(out), info.date1904)
          }
          while (cells!.length < col) cells!.push(null)
          cells![col] = out
          col++
          break
        }
        case 'row':
          if (cells!.some((c) => c != null && c !== '')) out.push(cells!)
          cells = null
          break
      }
    })
  })) {
    if (signal?.aborted) return
    yield row
  }
}
