import type { AssessmentSeverity } from '~~/shared/types/lab'

/** Health-check severity as label + badge tone + icon (never color alone). */
export const SEVERITY: Record<AssessmentSeverity, { label: string; tone: string; icon: string }> = {
  critical: { label: 'Critical', tone: 'bad', icon: 'lucide:octagon-alert' },
  warning: { label: 'Warning', tone: 'warn', icon: 'lucide:triangle-alert' },
  info: { label: 'Info', tone: 'info', icon: 'lucide:info' },
  ok: { label: 'OK', tone: 'ok', icon: 'lucide:circle-check' },
  na: { label: 'n/a', tone: '', icon: 'lucide:circle-minus' },
}
