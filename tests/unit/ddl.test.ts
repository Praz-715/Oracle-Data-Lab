import { describe, expect, it } from 'vitest'
import type { SchemaOptions } from '../../shared/types/lab'
import { buildSchemaDdl } from '../../server/generators/ddl'
import { estimateStorage } from '../../server/generators/estimate'

const base: SchemaOptions = {
  prefix: 'DL_',
  partitioning: 'interval',
  includeLobs: true,
  includePlsql: true,
  includeMaterializedViews: true,
  includeSynonyms: true,
  compression: false,
  extensionTables: 5,
  historyStart: '2023-01-01',
}

describe('schema DDL', () => {
  it('creates every object type and keeps names within 30 characters', () => {
    const { statements } = buildSchemaDdl({ ...base, prefix: 'LAB2026_' }, { schema: 'LAB', versionMajor: 11, partitioningAvailable: true })
    const types = new Set(statements.map((s) => s.objectType))
    for (const t of ['SEQUENCE', 'TABLE', 'CONSTRAINT', 'INDEX', 'VIEW', 'MATERIALIZED VIEW', 'SYNONYM', 'PACKAGE', 'PACKAGE BODY', 'PROCEDURE', 'FUNCTION', 'TRIGGER']) {
      expect(types.has(t), t).toBe(true)
    }
    for (const s of statements) expect(s.objectName.length, s.objectName).toBeLessThanOrEqual(30)
    expect(statements.map((s) => s.seq)).toEqual(statements.map((_, i) => i + 1))
  })

  it('creates tables before their foreign keys and indexes', () => {
    const { statements } = buildSchemaDdl(base, { schema: 'LAB', versionMajor: 19, partitioningAvailable: true })
    const firstFk = statements.findIndex((s) => s.objectType === 'CONSTRAINT')
    const lastTable = statements.map((s) => s.objectType).lastIndexOf('TABLE')
    expect(firstFk).toBeGreaterThan(lastTable)
  })

  it('emits the selected partitioning clause', () => {
    const sql = (p: SchemaOptions['partitioning']) =>
      buildSchemaDdl({ ...base, partitioning: p }, { schema: 'LAB', versionMajor: 19, partitioningAvailable: true, today: '2025-06-15' })
        .statements.find((s) => s.objectName === 'DL_ORDERS' && s.objectType === 'TABLE')!.sql
    expect(sql('interval')).toContain("INTERVAL (NUMTOYMINTERVAL(1, 'MONTH'))")
    expect(sql('range')).toContain('PARTITION P_202301')
    expect(sql('range')).toContain('MAXVALUE')
    expect(sql('list')).toContain('PARTITION BY LIST (CHANNEL)')
    expect(sql('hash')).toContain('PARTITION BY HASH (ORDER_ID)')
    expect(sql('none')).not.toContain('PARTITION BY')
  })

  it('falls back to no partitioning when the option is not installed', () => {
    const r = buildSchemaDdl(base, { schema: 'LAB', versionMajor: 19, partitioningAvailable: false })
    expect(r.effectiveOptions.partitioning).toBe('none')
    expect(r.warnings.join(' ')).toMatch(/Partitioning/)
  })

  it('puts index attributes before LOCAL', () => {
    const { statements } = buildSchemaDdl({ ...base, compression: true }, { schema: 'LAB', versionMajor: 19, partitioningAvailable: true })
    const ix = statements.find((s) => s.objectName === 'DL_ORD_CUS_DATE_IX')!.sql
    expect(ix).toMatch(/COMPRESS 1 LOCAL$/)
  })

  it('rejects unsafe identifiers', () => {
    expect(() => buildSchemaDdl({ ...base, prefix: 'DL;DROP' }, { schema: 'LAB', versionMajor: 19, partitioningAvailable: true })).toThrow()
    expect(() => buildSchemaDdl(base, { schema: 'LAB" --', versionMajor: 19, partitioningAvailable: true })).toThrow()
  })
})

describe('storage estimate', () => {
  it('scales with order volume and separates LOB bytes', () => {
    const small = estimateStorage({ orders: 17_000, includeLobs: true, extensionTables: 0, extensionRowsPerTable: 0 })
    const large = estimateStorage({ orders: 170_000, includeLobs: false, extensionTables: 0, extensionRowsPerTable: 0 })
    expect(small.totalRows).toBeGreaterThan(90_000)
    expect(small.totalRows).toBeLessThan(140_000)
    expect(large.tableBytes).toBeGreaterThan(small.tableBytes * 8)
    expect(small.lobBytes).toBeGreaterThan(0)
    expect(large.lobBytes).toBe(0)
  })
})
