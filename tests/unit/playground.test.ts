import { describe, expect, it } from 'vitest'
import { bindNames } from '../../shared/utils/sql'
import { cellValue, coerceBinds, statDelta } from '../../server/services/playground'

describe('SQL playground helpers', () => {
  it('finds bind variables outside literals, comments and quoted identifiers', () => {
    const sql = `SELECT :a, TO_CHAR(d, 'HH24:MI:SS') AS ":x" -- :comment
      FROM t /* :block */ WHERE c = :B AND d = :a AND e = q'[:quoted]' AND f = :b_2`
    expect(bindNames(sql)).toEqual(['a', 'B', 'b_2'])
    expect(bindNames(`SELECT 1 FROM DUAL WHERE x := 1`)).toEqual([])
  })

  it('binds everything as text (index-safe against VARCHAR2 columns); empty → NULL', () => {
    expect(coerceBinds(['d1', 'id', 'zip', 'big', 'missing'], { D1: '2017-11-01', id: ' 42 ', zip: '01037', big: '12345678901234567890' })).toEqual({
      d1: '2017-11-01',
      id: ' 42 ',
      zip: '01037',
      big: '12345678901234567890',
      missing: null,
    })
  })

  it('formats cells as JSON-safe values (dates as the database wall clock)', () => {
    expect(cellValue(new Date(2017, 10, 1, 9, 7, 6))).toBe('2017-11-01 09:07:06')
    expect(cellValue(Buffer.from([0xde, 0xad]))).toBe('0xDEAD')
    expect(cellValue(12.5)).toBe(12.5)
    expect(cellValue(null)).toBeNull()
  })

  it('subtracts the measurement overhead from statistic deltas', () => {
    expect(statDelta({ gets: 100 }, { gets: 160 }, { gets: 4 })).toEqual({ gets: 56 })
    expect(statDelta(null, { gets: 1 })).toBeNull()
  })
})
