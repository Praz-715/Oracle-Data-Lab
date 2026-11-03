import type { FixStep, Recommendation, RemediationPlan } from '../../shared/types/lab'
import { card, date, esc, htmlDocument, kpi } from '../services/report-html'

// Remediation advice as files: a .sql runbook (SQL*Plus / SQLcl syntax, RMAN and shell steps as
// comments) and a standalone HTML page. Both say plainly that nothing was executed.

const RULE = '-- ' + '='.repeat(96)
const THIN = '-- ' + '-'.repeat(96)
const KIND = { sql: 'SQL', rman: 'RMAN', shell: 'OS shell', check: 'Check (read-only)' } as const
const SEV = { critical: 'bad', warning: 'warn', info: 'info', ok: '', na: 'na' } as const

function wrap(text: string, width = 94): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    let line = ''
    for (const w of para.split(/\s+/)) {
      if (line && line.length + w.length + 1 > width) {
        out.push(line)
        line = w
      } else line = line ? `${line} ${w}` : w
    }
    out.push(line)
  }
  return out
}
const comment = (text: string, indent = '') => wrap(text).map((l) => `-- ${indent}${l}`.trimEnd())

function impactText(r: Recommendation) {
  const i = r.impact
  return [i.restart ? 'restart needed' : 'no restart', i.downtime ? 'downtime' : 'online', `risk ${i.risk}`, ...(i.enterpriseOnly ? ['Enterprise Edition only'] : [])].join(' · ')
}

/** Step code as it can sit in a .sql file: RMAN and shell lines are commented out with their prompt. */
function stepCode(s: FixStep) {
  if (s.kind === 'rman') return s.code.split('\n').map((l) => `-- RMAN> ${l}`).join('\n')
  if (s.kind === 'shell') return s.code.split('\n').map((l) => `-- $ ${l}`).join('\n')
  return s.code
}

function recSql(r: Recommendation, nr: number): string {
  const out = [THIN, `-- ${nr}. [${r.severity.toUpperCase()}] ${r.title} (${r.category})`, THIN, ...comment(`Why: ${r.why}`), ...comment(`Impact: ${impactText(r)}`)]
  for (const n of r.impact.notes) out.push(...comment(`- ${n}`, '  '))
  if (r.basedOn.length) {
    out.push('-- Based on (read from the database):')
    for (const b of r.basedOn) out.push(...comment(`- ${b}`, '  '))
  }
  if (r.prerequisites.length) {
    out.push('-- Before you start:')
    for (const p of r.prerequisites) out.push(...comment(`- ${p}`, '  '))
  }
  if (r.placeholders.length) {
    out.push('-- Replace these placeholders first:')
    for (const p of r.placeholders) out.push(...comment(`- ${p}`, '  '))
  }
  if (r.guidanceOnly) out.push('-- Guidance only: there is no safe generic script for this one.')
  const block = (label: string, s: FixStep) => ['--', `-- ${label}: ${s.title}`, `--   run as: ${s.runAs} [${KIND[s.kind]}]`, stepCode(s)]
  r.steps.forEach((s, i) => out.push(...block(`Step ${i + 1}`, s)))
  if (r.verify) out.push(...block('Verify', r.verify))
  if (r.rollback) out.push(...block('Rollback', r.rollback))
  return out.join('\n')
}

function header(meta: { profileName: string; dbName: string | null; container: string | null; version: string | null; generatedAt: string }) {
  return [
    RULE,
    '-- OracleDB Data Lab — remediation runbook (RECOMMENDATIONS ONLY)',
    `-- Database: ${meta.dbName ?? meta.profileName}${meta.container && meta.container !== meta.dbName ? ` / ${meta.container}` : ''}${meta.version ? ` · Oracle ${meta.version}` : ''} · profile "${meta.profileName}"`,
    `-- Generated: ${meta.generatedAt}`,
    '--',
    '-- Nothing in this file has been executed by the app. Read every step, replace the',
    '-- <<PLACEHOLDERS>>, and run the steps one at a time as the "run as" line says. RMAN and',
    '-- OS-shell steps are commented out because they do not run in SQL*Plus.',
    RULE,
    '',
    '-- Safety net: running this whole file by accident stops right here.',
    'PROMPT This is a runbook to read step by step, not a script to run as a whole.',
    'EXIT',
    '',
  ].join('\n')
}

export function planSql(plan: RemediationPlan): string {
  return header(plan) + plan.recommendations.map((r, i) => recSql(r, i + 1)).join('\n\n') + '\n'
}

export function recommendationSql(r: Recommendation, meta: Parameters<typeof header>[0]): string {
  return header(meta) + recSql(r, 1) + '\n'
}

// --- HTML --------------------------------------------------------------------------------------

const EXTRA_CSS = `<style>
.banner { padding: 10px 14px; border-radius: 8px; background: var(--warn-soft); color: var(--text); border: 1px solid var(--warn); }
.banner strong { color: var(--warn); }
.rec-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.step { margin-top: 14px; }
.step-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
.step-head .kind { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); border: 1px solid var(--border); border-radius: 4px; padding: 0 6px; }
.step-head .who { color: var(--text-3); font-size: 12px; }
ul.plain { margin: 4px 0 0; padding-left: 18px; }
ul.plain li { margin: 2px 0; }
h4 { margin: 12px 0 2px; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: var(--text-3); }
</style>`

function list(items: string[]) {
  return items.length ? `<ul class="plain">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''
}

function stepHtml(label: string, s: FixStep) {
  return `<div class="step"><div class="step-head"><strong>${esc(label)}: ${esc(s.title)}</strong><span class="kind">${esc(KIND[s.kind])}</span><span class="who">run as ${esc(s.runAs)}</span></div><pre>${esc(s.code)}</pre></div>`
}

function recHtml(r: Recommendation, nr: number) {
  const badges = [
    `<span class="badge ${SEV[r.severity]}">${esc(r.severity)}</span>`,
    `<span class="badge na">${esc(r.category)}</span>`,
    `<span class="badge ${r.impact.restart || r.impact.downtime ? 'warn' : ''}">${esc(impactText(r))}</span>`,
    ...(r.guidanceOnly ? ['<span class="badge info">guidance only</span>'] : []),
  ].join('')
  const body = [
    `<div class="rec-meta">${badges}</div>`,
    `<p>${esc(r.why)}</p>`,
    r.impact.notes.length ? `<h4>Impact</h4>${list(r.impact.notes)}` : '',
    r.prerequisites.length ? `<h4>Before you start</h4>${list(r.prerequisites)}` : '',
    r.placeholders.length ? `<h4>Placeholders to fill in</h4>${list(r.placeholders)}` : '',
    ...r.steps.map((s, i) => stepHtml(`Step ${i + 1}`, s)),
    r.verify ? stepHtml('Verify', r.verify) : '',
    r.rollback ? stepHtml('Rollback', r.rollback) : '',
    r.basedOn.length ? `<h4>Based on (read from the database)</h4>${list(r.basedOn)}` : '',
  ].join('')
  return card(`${nr}. ${r.title}`, body, { id: `rec-${r.findingId}` })
}

export function planHtml(plan: RemediationPlan): string {
  const recs = plan.recommendations
  const count = (s: string) => recs.filter((r) => r.severity === s).length
  const who = `${plan.dbName ?? plan.profileName}${plan.container && plan.container !== plan.dbName ? ` / ${plan.container}` : ''}`
  const body = `${EXTRA_CSS}
  <section class="card"><div class="card-body head">
    <h1>Remediation plan — ${esc(who)}</h1>
    <div class="meta">Profile ${esc(plan.profileName)}${plan.version ? ` · Oracle ${esc(plan.version)}` : ''} · generated ${esc(date(plan.generatedAt))} · ${plan.checked} health checks, ${plan.clean} passed</div>
  </div></section>
  <div class="banner"><strong>Recommendations only.</strong> Nothing on this page was executed by OracleDB Data Lab. Review each step, fill in the placeholders and run it yourself, one step at a time, in a maintenance window where the impact says so.</div>
  <div class="grid kpis">
    ${kpi('Critical', String(count('critical')), 'findings with a fix', count('critical') ? 'bad' : 'ok')}
    ${kpi('Warning', String(count('warning')), 'findings with a fix', count('warning') ? 'warn' : 'ok')}
    ${kpi('Info', String(count('info')), 'findings with a fix', 'info')}
    ${kpi('Restart needed', String(recs.filter((r) => r.impact.restart).length), 'recommendations', recs.some((r) => r.impact.restart) ? 'warn' : undefined)}
  </div>
  ${recs.length ? card('Contents', `<nav class="toc">${recs.map((r, i) => `<a href="#rec-${esc(r.findingId)}">${i + 1}. ${esc(r.title)}</a>`).join('')}</nav>`) : ''}
  ${recs.map((r, i) => recHtml(r, i + 1)).join('\n')}
  ${plan.failed.length ? card('Advice not available', list(plan.failed.map((f) => `${f.title}: ${f.reason}`))) : ''}`
  return htmlDocument(`Remediation plan — ${who}`, body, 'Generated by OracleDB Data Lab · recommendations only, nothing was executed')
}

export function recommendationHtml(r: Recommendation, meta: { profileName: string; dbName: string | null; container: string | null; version: string | null; generatedAt: string }): string {
  return planHtml({ ...meta, checked: 1, clean: 0, recommendations: [r], failed: [] })
}
