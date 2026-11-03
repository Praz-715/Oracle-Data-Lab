import type { AssessmentFinding, Recommendation, RemediationPlan } from '../../shared/types/lab'
import { withConnection } from '../database/driver'
import { oracleErrorInfo } from '../database/errors'
import { one } from '../database/query'
import { runCheck, runFindings } from '../services/assessment'
import { getProfile } from '../services/profiles'
import { buildRecommendation, fixContext, type FixCtx } from './fixes'

// Remediation advice for assessment findings. Everything here is read-only: the health check runs
// again (so the advice matches the database now, not an old report), the builders read their facts,
// and the result is text for the DBA. Nothing is executed against the database.

const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2, na: 3, ok: 4 } as const

async function build(c: FixCtx, f: AssessmentFinding): Promise<{ rec: Recommendation | null; error: string | null }> {
  try {
    return { rec: await buildRecommendation(c, f), error: null }
  } catch (err) {
    const i = oracleErrorInfo(err)
    return { rec: null, error: `${i.code}: ${i.hint ?? i.message}` }
  }
}

async function identity(c: FixCtx) {
  const r = await one<{ D: string | null }>(c.conn, `SELECT SYS_CONTEXT('USERENV', 'DB_NAME') AS "D" FROM DUAL`)
  return { dbName: r?.D ?? null, container: c.container, version: c.conn.oracleServerVersionString ?? null }
}

export interface FindingAdvice {
  finding: AssessmentFinding
  recommendation: Recommendation | null
  /** Why there is no recommendation (check passes now, privilege missing…). */
  reason: string | null
  meta: { profileName: string; dbName: string | null; container: string | null; version: string | null; generatedAt: string }
}

export async function recommendationFor(profileId: string, findingId: string): Promise<FindingAdvice> {
  const profile = await getProfile(profileId)
  return withConnection(
    profileId,
    async (conn) => {
      const finding = await runCheck(conn, findingId)
      if (!finding) throw createError({ statusCode: 404, statusMessage: `Unknown health check ${findingId}` })
      const c = await fixContext(conn)
      const { rec, error } = await build(c, finding)
      const reason = error ?? (rec ? null : finding.severity === 'ok' ? 'The check passes now — nothing to fix.' : finding.severity === 'na' ? 'The check could not run with this account / version.' : 'Nothing left to fix.')
      return { finding, recommendation: rec, reason, meta: { profileName: profile.name, generatedAt: nowIso(), ...(await identity(c)) } }
    },
    { action: 'recommend:finding', callTimeoutMs: 180000 },
  )
}

export async function remediationPlan(profileId: string): Promise<RemediationPlan> {
  const profile = await getProfile(profileId)
  return withConnection(
    profileId,
    async (conn) => {
      const findings = await runFindings(conn)
      const c = await fixContext(conn)
      const recommendations: Recommendation[] = []
      const failed: RemediationPlan['failed'] = []
      for (const f of findings.filter((x) => x.severity !== 'ok' && x.severity !== 'na')) {
        const { rec, error } = await build(c, f)
        if (rec) recommendations.push(rec)
        else if (error) failed.push({ findingId: f.id, title: f.title, reason: error })
      }
      recommendations.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      return {
        generatedAt: nowIso(),
        profileName: profile.name,
        ...(await identity(c)),
        checked: findings.length,
        clean: findings.filter((f) => f.severity === 'ok').length,
        recommendations,
        failed,
      }
    },
    { action: 'recommend:plan', callTimeoutMs: 300000 },
  )
}
