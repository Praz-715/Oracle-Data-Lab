import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterAll, describe, expect, it } from 'vitest'
import { ColumnStats, oracleName, profileColumns, tableNameFromFile } from '../../server/datasets/infer'
import { listSheets, readRows, sniffCsv } from '../../server/datasets/reader'
import { isDateFormat, serialToText } from '../../server/datasets/xlsx'
import { bindExpr, createTableSql, insertSql, normalizeType, reconcileLoad, shortName, textLimit, transformValue, validateMask } from '../../server/datasets/sql'

const col = (values: (string | null)[], header = 'x') => {
  const s = new ColumnStats(0, header)
  for (const v of values) s.add(v)
  return s.finish(oracleName(header))
}

describe('type inference', () => {
  it('integers, decimals and their Oracle sizes', () => {
    expect(col(['1', '22', '-333'])).toMatchObject({ kind: 'integer', oracleType: 'NUMBER(5)', min: '-333', max: '22' })
    expect(col(['58.90', '239.9', '6735.00'])).toMatchObject({ kind: 'decimal', oracleType: 'NUMBER(8,2)' })
    expect(col(['-23.54562128115268', '-46.6'])).toMatchObject({ kind: 'decimal', oracleType: 'NUMBER(18,14)' })
  })

  it('keeps codes with leading zeros as text', () => {
    const c = col(['14409', '09790', '01037'])
    expect(c).toMatchObject({ kind: 'text', keepAsText: true, oracleType: 'VARCHAR2(5 CHAR)' })
  })

  it('decimal comma numbers (Indonesian/European exports)', () => {
    expect(col(['1.234,56', '12,5', '7'])).toMatchObject({ kind: 'decimal', decimalComma: true })
  })

  it('dates and timestamps with the right Oracle mask', () => {
    expect(col(['2017-10-02 10:56:33', '2018-01-18 00:00:00'])).toMatchObject({ kind: 'timestamp', oracleType: 'DATE', dateMask: 'YYYY-MM-DD HH24:MI:SS', min: '2017-10-02 10:56:33' })
    expect(col(['2024-01-15', '2024-02-29'])).toMatchObject({ kind: 'date', dateMask: 'YYYY-MM-DD' })
    expect(col(['2024-01-15T08:00:00.123', '2024-01-16T09:00:00.5'])).toMatchObject({ oracleType: 'TIMESTAMP(3)', dateMask: 'YYYY-MM-DD"T"HH24:MI:SS.FF' })
    // Day-first wins when ambiguous; 25/12 is only valid day-first.
    expect(col(['25/12/2023', '01/02/2024'])).toMatchObject({ kind: 'date', dateMask: 'DD/MM/YYYY' })
    expect(col(['12/25/2023', '02/01/2024'])).toMatchObject({ kind: 'date', dateMask: 'MM/DD/YYYY' })
    // Mixed date-only and date-time values use the date-time mask (Oracle accepts missing time).
    expect(col(['2024-01-15', '2024-01-16 10:00'])).toMatchObject({ dateMask: 'YYYY-MM-DD HH24:MI' })
    expect(col(['2024-13-01'])).toMatchObject({ kind: 'text' })
  })

  it('text widths, fixed-length codes, CLOB, nulls and uniqueness', () => {
    expect(col(['SP', 'RJ', 'MG'])).toMatchObject({ oracleType: 'VARCHAR2(2 CHAR)', unique: true })
    expect(col(['sao paulo', 'franca', 'rio'])).toMatchObject({ oracleType: 'VARCHAR2(10 CHAR)' })
    expect(col(['x'.repeat(5000)])).toMatchObject({ oracleType: 'CLOB' })
    expect(col([null, '', '  '])).toMatchObject({ kind: 'empty', nulls: 3 })
    expect(col(['a', 'a'])).toMatchObject({ unique: false, distinct: 1 })
  })

  it('Oracle-safe names', () => {
    expect(oracleName('order_purchase_timestamp')).toBe('ORDER_PURCHASE_TIMESTAMP')
    expect(oracleName('Tanggal Transaksi (WIB)')).toBe('TANGGAL_TRANSAKSI_WIB')
    expect(oracleName('2nd value')).toBe('C_2ND_VALUE')
    expect(oracleName('date')).toBe('DATE_')
    expect(oracleName('São Paulo')).toBe('SAO_PAULO')
    const used = new Set<string>()
    expect([oracleName('a', used), oracleName('A', used), oracleName('a!', used)]).toEqual(['A', 'A_2', 'A_3'])
    expect(oracleName('x'.repeat(40)).length).toBe(30)
    expect(tableNameFromFile('raw/olist_orders_dataset.csv')).toBe('OLIST_ORDERS_DATASET')
  })

  it('profiles a small table', () => {
    const p = profileColumns(['id', 'when'], [['1', '2024-01-01'], ['2', '2024-01-02']])
    expect(p.map((c) => c.kind)).toEqual(['integer', 'date'])
  })
})

describe('import SQL', () => {
  it('validates types and masks', () => {
    expect(normalizeType(' varchar2(40  char) ')).toBe('VARCHAR2(40 CHAR)')
    expect(normalizeType('number(10,2)')).toBe('NUMBER(10,2)')
    expect(() => normalizeType('VARCHAR2(10); DROP TABLE X')).toThrow()
    expect(() => validateMask("YYYY'||x")).toThrow()
    expect(textLimit('VARCHAR2(10 CHAR)')).toEqual({ size: 10, bytes: false })
    expect(textLimit('VARCHAR2(10)')).toEqual({ size: 10, bytes: true })
  })

  it('builds conversion expressions and statements', () => {
    expect(bindExpr({ type: 'NUMBER(5)' }, 1)).toBe('TO_NUMBER(:1)')
    expect(bindExpr({ type: 'DATE', dateMask: 'DD/MM/YYYY' }, 2)).toBe("TO_DATE(:2, 'DD/MM/YYYY')")
    expect(bindExpr({ type: 'TIMESTAMP(3)' }, 3)).toBe("TO_TIMESTAMP(:3, 'YYYY-MM-DD HH24:MI:SS.FF')")
    const cols = [{ target: 'A', type: 'NUMBER(5)' }, { target: 'B', type: 'VARCHAR2(5 CHAR)' }]
    expect(insertSql('S', 'T', cols, true)).toBe('INSERT INTO S.T (A, B, DL_IMPORT_ID) VALUES (TO_NUMBER(:1), :2, :3)')
    expect(createTableSql('S', 'T', cols, true)).toContain('DL_IMPORT_ID VARCHAR2(36)')
    expect(shortName('OL_CATEGORY_TRANSLATION_LONG_NAME', '_PK')).toBe('OL_CATEGORY_TRANSLATION_LON_PK')
  })

  it('reconciles a batch committed after the last checkpoint (exactly-once resume)', () => {
    const cp = { rowsRead: 435_000, inserted: 435_000, rejected: 0, samples: [] }
    // Nothing extra committed: unchanged.
    expect(reconcileLoad(cp, 435_000, 5000, 1_000_163)).toEqual({ state: cp, skipped: 0 })
    // One full batch committed, two of its rows rejected.
    expect(reconcileLoad(cp, 439_998, 5000, 1_000_163)).toMatchObject({ skipped: 5000, state: { rowsRead: 440_000, inserted: 439_998, rejected: 2 } })
    // Final partial batch.
    expect(reconcileLoad({ rowsRead: 1_000_000, inserted: 1_000_000, rejected: 0 }, 1_000_163, 5000, 1_000_163)).toMatchObject({ skipped: 163, state: { rowsRead: 1_000_163 } })
    // More than one batch cannot be explained: refuse.
    expect(() => reconcileLoad(cp, 446_000, 5000, 1_000_163)).toThrow()
  })

  it('transforms values', () => {
    const c = { source: 0, target: 'X', type: 'NUMBER(10,2)', decimalComma: true }
    expect(transformValue(c, ' 1.234,5 ')).toBe('1234.5')
    expect(transformValue(c, '   ')).toBeNull()
    expect(transformValue({ source: null, target: 'Y', type: 'VARCHAR2(5)', constant: 'LAB' }, 'ignored')).toBe('LAB')
    expect(transformValue({ source: 0, target: 'Z', type: 'VARCHAR2(5)', trim: false, emptyAsNull: false }, ' a ')).toBe(' a ')
  })
})

describe('readers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'odl-import-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))
  const all = async (it: AsyncIterable<(string | null)[]>) => {
    const out: (string | null)[][] = []
    for await (const r of it) out.push(r)
    return out
  }

  it('reads CSV with BOM, mixed quoting and quoted newlines', async () => {
    const f = join(dir, 'a.csv')
    writeFileSync(f, '﻿"id","comment",zip\r\n1,"line one\nline two","01037"\r\n"2",plain,14409\r\n')
    expect(await sniffCsv(f)).toMatchObject({ delimiter: ',', encoding: 'utf8', bom: true })
    expect(await all(readRows(f, { format: 'csv' }))).toEqual([['id', 'comment', 'zip'], ['1', 'line one\nline two', '01037'], ['2', 'plain', '14409']])
  })

  it('detects semicolon delimiter and latin1', async () => {
    const f = join(dir, 'b.csv')
    writeFileSync(f, Buffer.from('nama;kota\nJos\xe9;S\xe3o Paulo\n', 'latin1'))
    const d = await sniffCsv(f)
    expect(d).toMatchObject({ delimiter: ';', encoding: 'latin1' })
    expect(await all(readRows(f, { format: 'csv' }))).toEqual([['nama', 'kota'], ['José', 'São Paulo']])
  })

  it('reads XLSX sheets with dates, rich text and formulas', async () => {
    const f = join(dir, 'c.xlsx')
    const wb = new ExcelJS.Workbook()
    const s1 = wb.addWorksheet('Ringkasan')
    s1.addRow(['x'])
    const s2 = wb.addWorksheet('Penjualan')
    s2.addRow(['kode', 'tanggal', 'jumlah', 'catatan', 'total'])
    s2.addRow(['00123', new Date(Date.UTC(2024, 0, 15)), 3, { richText: [{ text: 'halo ' }, { text: 'dunia' }] }, { formula: 'C2*2', result: 6 }])
    s2.addRow(['00456', new Date(Date.UTC(2024, 1, 29, 13, 45, 10)), 1.5, 'teks', { formula: 'C3*2', result: 3 }])
    await wb.xlsx.writeFile(f)
    expect(await listSheets(f)).toEqual(['Ringkasan', 'Penjualan'])
    expect(await all(readRows(f, { format: 'xlsx', sheet: 'Penjualan' }))).toEqual([
      ['kode', 'tanggal', 'jumlah', 'catatan', 'total'],
      ['00123', '2024-01-15', '3', 'halo dunia', '6'],
      ['00456', '2024-02-29 13:45:10', '1.5', 'teks', '3'],
    ])
    expect(await all(readRows(f, { format: 'xlsx' }))).toEqual([['x']])
    // Deterministic regardless of zip entry order (exceljs writes workbook.xml last).
    for (let i = 0; i < 5; i++) expect((await all(readRows(f, { format: 'xlsx', sheet: 'Penjualan' }))).length).toBe(3)
  })

  it('Excel date formats and serials', () => {
    expect(isDateFormat('dd/mm/yyyy hh:mm')).toBe(true)
    expect(isDateFormat('[$-421]d mmmm yyyy')).toBe(true)
    expect(isDateFormat('#,##0.00')).toBe(false)
    expect(isDateFormat('"Rp"#,##0')).toBe(false)
    expect(serialToText(45306)).toBe('2024-01-15')
    expect(serialToText(45351.5730324074)).toBe('2024-02-29 13:45:10')
    expect(serialToText(0, true)).toBe('1904-01-01')
  })
})
