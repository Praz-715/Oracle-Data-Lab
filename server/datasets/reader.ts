import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { parse } from 'csv-parse'
import type { SourceFormat } from '../../shared/types/lab'
import { readXlsxRows } from './xlsx'

export { listSheets } from './xlsx'

// Streaming readers for CSV/TSV and XLSX. Both yield one array of cell strings per record (the
// header row included), so profiling and importing never hold a whole file in memory.

export type CsvEncoding = 'utf8' | 'latin1'

export interface CsvDialect {
  delimiter: string
  encoding: CsvEncoding
  bom: boolean
}

export interface ReadOptions {
  format: SourceFormat
  sheet?: string | null
  delimiter?: string | null
  encoding?: string | null
  signal?: AbortSignal
}

const CANDIDATES = [',', ';', '\t', '|']

/** Counts a delimiter outside double quotes on one line. */
function countOutsideQuotes(line: string, d: string) {
  let n = 0
  let q = false
  for (const ch of line) {
    if (ch === '"') q = !q
    else if (!q && ch === d) n++
  }
  return n
}

/** Guesses delimiter and encoding from the first 64 KiB. */
export async function sniffCsv(file: string): Promise<CsvDialect> {
  const fh = await open(file, 'r')
  let buf: Buffer
  try {
    const b = Buffer.alloc(64 * 1024)
    const { bytesRead } = await fh.read(b, 0, b.length, 0)
    buf = b.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  // Cut at the last newline so a multi-byte character split by the 64 KiB window is not a false alarm.
  const cut = buf.lastIndexOf(0x0a)
  let encoding: CsvEncoding = 'utf8'
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(cut > 0 ? buf.subarray(0, cut) : buf)
  } catch {
    encoding = 'latin1'
  }
  const decoded = buf.toString(encoding === 'utf8' ? 'utf8' : 'latin1')
  const text = decoded.charCodeAt(0) === 0xfeff ? decoded.slice(1) : decoded
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 20)
  let best = ','
  let bestScore = 0
  for (const d of CANDIDATES) {
    const counts = lines.map((l) => countOutsideQuotes(l, d))
    const header = counts[0] ?? 0
    if (!header) continue
    // Prefer the delimiter whose count is the same on most lines (quoted newlines make a few differ).
    const consistent = counts.filter((c) => c === header).length
    const score = consistent * 1000 + header
    if (score > bestScore) {
      best = d
      bestScore = score
    }
  }
  return { delimiter: best, encoding, bom }
}

async function* readCsv(file: string, opts: ReadOptions): AsyncGenerator<(string | null)[]> {
  const sniff = opts.delimiter && opts.encoding ? null : await sniffCsv(file)
  const parser = createReadStream(file).pipe(
    parse({
      delimiter: opts.delimiter || sniff!.delimiter,
      encoding: (opts.encoding || sniff!.encoding) as BufferEncoding,
      bom: true,
      relax_quotes: true,
      relax_column_count: true,
      skip_empty_lines: true,
    }),
  )
  try {
    for await (const rec of parser as AsyncIterable<string[]>) {
      if (opts.signal?.aborted) return
      yield rec
    }
  } finally {
    parser.destroy()
  }
}

/** Yields every record of the file (header row first). */
export function readRows(file: string, opts: ReadOptions): AsyncGenerator<(string | null)[]> {
  return opts.format === 'xlsx' ? readXlsxRows(file, opts.sheet, opts.signal) : readCsv(file, opts)
}
