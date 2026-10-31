import type { StorageEstimate } from '../../shared/types/lab'
import { blueprintTables } from './blueprint'
import { deriveCounts, expectedRows } from './model'

// Oracle row overhead (row header + column length bytes) and block fill assumptions.
const ROW_OVERHEAD = 5
const BLOCK_FILL = 0.85
const INDEX_ENTRY_OVERHEAD = 12

export const SIZE_PRESETS = {
  small: { label: 'Small', targetRows: 100_000, orders: 17_000 },
  medium: { label: 'Medium', targetRows: 1_000_000, orders: 170_000 },
  large: { label: 'Large', targetRows: 10_000_000, orders: 1_700_000 },
  xl: { label: 'XL', targetRows: 50_000_000, orders: 8_500_000 },
} as const

/**
 * Statistical estimate from blueprint column averages. This is a planning number, not a measurement:
 * after generation, compare with segment sizes in Tablespaces & Storage.
 */
export function estimateStorage(opts: { orders: number; includeLobs: boolean; extensionTables: number; extensionRowsPerTable: number }): StorageEstimate {
  const counts = deriveCounts(opts.orders, opts.extensionTables, opts.extensionRowsPerTable)
  const rowsBy = expectedRows(counts, opts.includeLobs)
  const tables = blueprintTables({ includeLobs: opts.includeLobs, extensionTables: opts.extensionTables })
  let tableBytes = 0
  let indexBytes = 0
  let lobBytes = 0
  const out = []
  for (const t of tables) {
    const rows = rowsBy[t.key] ?? 0
    if (!rows) continue
    const inRow = t.columns.filter((c) => !c.lob).reduce((n, c) => n + c.avgBytes + 1, ROW_OVERHEAD)
    const lob = t.columns.filter((c) => c.lob).reduce((n, c) => n + c.avgBytes, 0)
    const bytes = Math.round((rows * inRow) / BLOCK_FILL)
    tableBytes += bytes
    lobBytes += Math.round((rows * lob) / BLOCK_FILL)
    const keyed = [t.pk, ...(t.uniques ?? []).map((u) => u.cols), ...(t.indexes ?? []).map((i) => i.cols)]
    for (const cols of keyed) {
      const keyBytes = cols.reduce((n, name) => n + (t.columns.find((c) => c.name === name)?.avgBytes ?? 6) + 1, INDEX_ENTRY_OVERHEAD)
      indexBytes += Math.round((rows * keyBytes) / BLOCK_FILL)
    }
    out.push({ table: t.key, rows, avgRowBytes: inRow + lob, bytes })
  }
  const totalRows = out.reduce((n, t) => n + t.rows, 0)
  return {
    tables: out,
    totalRows,
    tableBytes,
    indexBytes,
    lobBytes,
    totalBytes: tableBytes + indexBytes + lobBytes,
    note: 'Estimate from blueprint column averages (row overhead + 85% block fill). Actual segment sizes depend on PCTFREE, compression, character set and extent allocation.',
  }
}
