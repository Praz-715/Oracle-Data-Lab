import { describe, expect, it } from 'vitest'
import { foldClass, summarizeActivity, type ActiveSample, type ActivityTick } from '../../server/database/activity'
import { OLIST_SCENARIOS } from '../../server/benchmarks/olist'
import { SCENARIOS, scenarioInfo, type ScenarioEnv, type WorkerState } from '../../server/benchmarks/scenarios'
import { Rng } from '../../server/generators/prng'

const s = (sid: number, cls: ActiveSample['cls'], sqlId: string | null, event = cls === 'CPU' ? 'ON CPU' : 'db file sequential read'): ActiveSample => ({ sid, user: 'LAB', sqlId, event, cls, module: 'OracleDB Data Lab' })

describe('ASH-lite', () => {
  it('folds wait classes into six chart classes', () => {
    expect(foldClass(true, 'User I/O')).toBe('CPU')
    expect(foldClass(false, 'User I/O')).toBe('User I/O')
    expect(foldClass(false, 'Commit')).toBe('Commit')
    expect(foldClass(false, 'System I/O')).toBe('Other')
    expect(foldClass(false, 'Cluster')).toBe('Other')
    expect(foldClass(false, null)).toBe('Other')
  })

  it('computes average active sessions, top SQL, events and sessions within the window', () => {
    const t0 = 1_000_000
    const ticks: ActivityTick[] = [
      { ts: t0 - 1000, rows: [s(1, 'CPU', 'aaa')] }, // before the window: ignored
      { ts: t0, rows: [s(1, 'CPU', 'aaa'), s(2, 'User I/O', 'bbb')] },
      { ts: t0 + 1000, rows: [s(1, 'CPU', 'aaa'), s(9, 'Commit', 'zzz', 'log file sync')] },
      { ts: t0 + 2000, rows: [] },
      { ts: t0 + 3000, rows: [s(2, 'User I/O', 'aaa')] },
    ]
    const sum = summarizeActivity(ticks, { source: 'ash-lite', intervalSec: 1, t0, filter: (x) => x.sid !== 9 })
    expect(sum.ticks).toBe(4)
    expect(sum.samples).toBe(4)
    expect(sum.aas).toBe(1)
    expect(sum.byClass.CPU).toBe(0.5)
    expect(sum.byClass['User I/O']).toBe(0.5)
    expect(sum.byClass.Commit).toBe(0)
    expect(sum.topSql[0]).toMatchObject({ sqlId: 'aaa', samples: 3, pct: 75, topEvent: 'ON CPU' })
    expect(sum.topEvents.map((e) => e.event)).toEqual(['ON CPU', 'db file sequential read'])
    expect(sum.topSessions[0]).toMatchObject({ sid: 1, samples: 2 })
    expect(sum.series.map((p) => p.t)).toEqual([0, 1, 2, 3])
    expect(sum.series[2]!.v.CPU).toBe(0)
  })

  it('averages buckets over their ticks', () => {
    const t0 = 0
    const ticks: ActivityTick[] = Array.from({ length: 10 }, (_, i) => ({ ts: i * 1000, rows: i < 5 ? [s(1, 'CPU', 'x'), s(2, 'CPU', 'x')] : [] }))
    const sum = summarizeActivity(ticks, { source: 'ash-lite', intervalSec: 1, t0, bucketSec: 5 })
    expect(sum.series).toEqual([
      { t: 0, v: { CPU: 2, 'User I/O': 0, Commit: 0, Concurrency: 0, Application: 0, Other: 0 } },
      { t: 5, v: { CPU: 0, 'User I/O': 0, Commit: 0, Concurrency: 0, Application: 0, Other: 0 } },
    ])
    expect(sum.aas).toBe(1)
  })
})

describe('Olist scenarios', () => {
  const env: ScenarioEnv = {
    S: 'LAB',
    P: 'OL_',
    runId: 'r',
    versionMajor: 19,
    batchSize: 100,
    readRatio: 0.8,
    ranges: { orderMin: 0, orderMax: 0, customerMin: 0, customerMax: 0, productMin: 0, productMax: 0, regionIds: [], dateMin: new Date(0), dateMax: new Date(0) },
    olist: { orderIds: ['o1', 'o2'], customerUniqueIds: ['c1'], sellerIds: ['s1'], zips: ['01037'], dateMin: new Date('2016-09-04'), dateMax: new Date('2018-10-17') },
  }

  it('are registered as read-only Olist scenarios with unique numbers', () => {
    expect(OLIST_SCENARIOS).toHaveLength(8)
    for (const sc of OLIST_SCENARIOS) {
      expect(scenarioInfo(sc)).toMatchObject({ dataset: 'olist', defaultPrefix: 'OL_', writes: false })
    }
    const nos = SCENARIOS.map((x) => x.no)
    expect(new Set(nos).size).toBe(nos.length)
    expect(scenarioInfo(SCENARIOS[0]!)).toMatchObject({ dataset: 'retail', defaultPrefix: 'DL_' })
  })

  it('produce tagged, bound SQL against the prefixed tables', () => {
    for (const sc of OLIST_SCENARIOS) {
      const w: WorkerState = { worker: 1, rng: new Rng(42), opIndex: 0, ids: [], cursor: 0 }
      for (let i = 0; i < 20; i++) {
        const op = sc.next(env, w)
        expect(op.kind).toBe('query')
        if (op.kind !== 'query') continue
        expect(op.sql).toContain('/* ODL-BENCH ol-')
        expect(op.sql).toContain('LAB.OL_')
        // Every :bind in the statement has a value, and date windows stay inside the history.
        for (const m of op.sql.matchAll(/:([a-z]\w*)/g)) expect(op.binds).toHaveProperty(m[1]!)
        if ('d1' in op.binds) {
          expect(String(op.binds.d1) >= '2016-09-04').toBe(true)
          expect(String(op.binds.d2) <= '2018-10-18').toBe(true)
        }
      }
    }
  })
})
