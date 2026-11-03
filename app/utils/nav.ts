export interface NavItem {
  to: string
  label: string
  icon: string
  /** Shown as "planned" — the module is not built yet and is never simulated. */
  planned?: boolean
}

export const NAV: { section: string; items: NavItem[] }[] = [
  {
    section: 'Workspace',
    items: [
      { to: '/', label: 'Overview', icon: 'lucide:layout-dashboard' },
      { to: '/connections', label: 'Connections', icon: 'lucide:plug' },
    ],
  },
  {
    section: 'Data',
    items: [
      { to: '/datasets', label: 'Dataset Sources', icon: 'lucide:library' },
      { to: '/schema', label: 'Schema Designer', icon: 'lucide:blocks' },
      { to: '/generator', label: 'Data Generator', icon: 'lucide:factory' },
      { to: '/quality', label: 'Data Quality', icon: 'lucide:shield-check' },
      { to: '/import', label: 'Import Manager', icon: 'lucide:file-input' },
      { to: '/explorer', label: 'Table Explorer', icon: 'lucide:table-2' },
      { to: '/analytics', label: 'Visual Analytics', icon: 'lucide:chart-column' },
    ],
  },
  {
    section: 'Performance',
    items: [
      { to: '/performance', label: 'Performance Lab', icon: 'lucide:gauge' },
      { to: '/playground', label: 'SQL Playground', icon: 'lucide:square-terminal' },
      { to: '/tuning', label: 'SQL Tuning', icon: 'lucide:wrench' },
      { to: '/diagnostics', label: 'SQL Diagnostics', icon: 'lucide:stethoscope' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { to: '/assessment', label: 'Database Assessment', icon: 'lucide:clipboard-check' },
      { to: '/monitoring', label: 'Instance Monitoring', icon: 'lucide:activity' },
      { to: '/storage', label: 'Tablespaces & Storage', icon: 'lucide:hard-drive' },
    ],
  },
  {
    section: 'Enterprise HA/DR',
    items: [
      { to: '/rac', label: 'RAC Lab', icon: 'lucide:network' },
      { to: '/dataguard', label: 'Data Guard Lab', icon: 'lucide:shield' },
      { to: '/rman', label: 'RMAN Lab', icon: 'lucide:archive' },
    ],
  },
  {
    section: 'System',
    items: [
      { to: '/jobs', label: 'Job History', icon: 'lucide:list-checks' },
      { to: '/settings', label: 'Settings', icon: 'lucide:settings' },
    ],
  },
]
