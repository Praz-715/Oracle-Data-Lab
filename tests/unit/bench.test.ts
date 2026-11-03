import { describe, expect, it } from 'vitest'
import { LatencyHistogram } from '../../server/benchmarks/histogram'
import { SCENARIOS, inlineBinds, type ScenarioEnv, type WorkerState } from '../../server/benchmarks/scenarios'
import { Rng } from '../../server/generators/prng'
import { analyzeErrors, assertSelectOnly, parseAlertText } from '../../server/services/tuning'

describe('latency histogram', () => {
  it('computes percentiles within ~2%', () => {
    const h = new LatencyHistogram()
    for (let i = 1; i <= 10_000; i++) h.record(i / 10) // 0.1 .. 1000 ms uniform
    const s = h.summary()
    expect(s.count).toBe(10_000)
    expect(Math.abs(s.p50Ms - 500) / 500).toBeLessThan(0.02)
    expect(Math.abs(s.p95Ms - 950) / 950).toBeLessThan(0.02)
    expect(Math.abs(s.p99Ms - 990) / 990).toBeLessThan(0.02)
    expect(s.maxMs).toBe(1000)
  })

  it('merges', () => {
    const a = new LatencyHistogram()
    const b = new LatencyHistogram()
    a.record(1)
    b.record(3)
    a.merge(b)
    expect(a.count).toBe(2)
    expect(a.summary().avgMs).toBe(2)
  })
})

describe('benchmark scenarios', () => {
  const env: ScenarioEnv = {
    S: 'LAB', P: 'DL_', runId: 'run', versionMajor: 11, batchSize: 10, readRatio: 0.8,
    ranges: { orderMin: 1, orderMax: 1000, customerMin: 1, customerMax: 100, productMin: 1, productMax: 50, regionIds: [1, 2], dateMin: new Date(2024, 0, 1), dateMax: new Date(2025, 0, 1) },
  }

  const retail = SCENARIOS.filter((s) => (s.dataset ?? 'retail') === 'retail')

  it('covers the 18 retail scenarios plus the 8 Olist scenarios with unique ids', () => {
    expect(retail.map((s) => s.no)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(SCENARIOS.map((s) => s.no)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1))
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(26)
  })

  it('every retail scenario produces executable-looking SQL against the lab schema', () => {
    for (const s of retail) {
      const w: WorkerState = { worker: 1, rng: new Rng(1), opIndex: 0, ids: [1, 2, 3], cursor: 0 }
      const op = s.next(env, w)
      expect(op.sql, s.id).toContain('LAB.DL_')
      if (op.kind !== 'many') {
        for (const m of op.sql.matchAll(/:([a-z]\w*)/g)) expect(Object.keys(op.binds), `${s.id} :${m[1]}`).toContain(m[1])
      }
    }
  })

  it('uses ROWNUM pagination on 11g and OFFSET/FETCH on 12c+', () => {
    const p = SCENARIOS.find((s) => s.id === 'pagination')!
    const w: WorkerState = { worker: 1, rng: new Rng(2), opIndex: 0, ids: [], cursor: 0 }
    expect(p.next(env, w).sql).toContain('ROWNUM')
    expect(p.next({ ...env, versionMajor: 19 }, w).sql).toContain('FETCH NEXT')
  })

  it('inlines binds for EXPLAIN PLAN', () => {
    const sql = inlineBinds('SELECT * FROM T WHERE A = :a AND B = :b AND C >= :c', { a: 5, b: "O'Brien", c: new Date(2025, 0, 2, 3, 4, 5) })
    expect(sql).toBe("SELECT * FROM T WHERE A = 5 AND B = 'O''Brien' AND C >= TO_DATE('2025-01-02 03:04:05', 'YYYY-MM-DD HH24:MI:SS')")
  })
})

describe('tuning helpers', () => {
  it('accepts only single SELECT statements', () => {
    expect(assertSelectOnly('select 1 from dual;')).toBe('select 1 from dual')
    expect(assertSelectOnly('/* c */ WITH x AS (SELECT 1 a FROM dual) SELECT * FROM x')).toContain('WITH')
    expect(() => assertSelectOnly('DELETE FROM t')).toThrow()
    expect(() => assertSelectOnly('SELECT 1 FROM dual; DROP TABLE t')).toThrow()
    expect(() => assertSelectOnly('SELECT * FROM t FOR UPDATE')).toThrow()
  })

  it('groups ORA errors from alert-log text with timestamps', () => {
    const text = [
      '2025-03-01T10:00:00.000000+07:00',
      'ORA-01653: unable to extend table LAB.DL_ORDERS by 128 in tablespace USERS',
      '2025-03-01T11:00:00.000000+07:00',
      'Errors in file /u01/trace/orcl_ora_123.trc:',
      'ORA-01653: unable to extend table LAB.DL_ORDER_ITEMS by 128 in tablespace USERS',
      'ORA-00060: deadlock detected while waiting for resource',
    ].join('\n')
    const groups = analyzeErrors(parseAlertText(text))
    expect(groups[0]!.code).toBe('ORA-01653')
    expect(groups[0]!.count).toBe(2)
    expect(groups[0]!.first).toBe('2025-03-01T10:00:00')
    expect(groups[0]!.last).toBe('2025-03-01T11:00:00')
    expect(groups[0]!.guidance).toMatch(/tablespace/)
    expect(groups.find((g) => g.code === 'ORA-00060')).toBeTruthy()
  })
})
