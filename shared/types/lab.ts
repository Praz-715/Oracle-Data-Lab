// Types shared by the browser app and the server API. Never put credentials in these shapes
// except ConnectionInput.password, which only travels browser -> server.

export type ConnectMethod = 'service' | 'sid' | 'descriptor'
export type ProfileMode = 'read-only' | 'lab'
export type ServerType = 'dedicated' | 'shared' | 'pooled' | 'default'

export interface ConnectionProfile {
  id: string
  name: string
  host: string
  port: number
  method: ConnectMethod
  serviceName: string
  sid: string
  descriptor: string
  serverType: ServerType
  username: string
  hasPassword: boolean
  privilege: 'none' | 'sysdba' | 'sysoper' | 'sysbackup' | 'sysdg'
  walletLocation: string
  useTls: boolean
  mode: ProfileMode
  /** Schemas where this app may create objects / write data. Upper-case. */
  allowedSchemas: string[]
  notes: string
  createdAt: string
  updatedAt: string
}

export interface ConnectionInput {
  name: string
  host: string
  port: number
  method: ConnectMethod
  serviceName?: string
  sid?: string
  descriptor?: string
  serverType?: ServerType
  username: string
  password?: string
  privilege?: ConnectionProfile['privilege']
  walletLocation?: string
  walletPassword?: string
  useTls?: boolean
  mode?: ProfileMode
  allowedSchemas?: string[]
  notes?: string
}

/** Result of a metric/inventory query that may be blocked by privileges, edition or licensing. */
export type Panel<T> =
  | { status: 'ok'; data: T; collectedAt: string; note?: string }
  | { status: 'unavailable'; reason: string; code?: string; requires?: string; collectedAt: string }

export interface DbEnvironment {
  connected: boolean
  serverVersion: string
  versionMajor: number
  banner: string
  edition: string
  dbName: string | null
  dbUniqueName: string | null
  instanceName: string | null
  hostName: string | null
  instanceStatus: string | null
  startupTime: string | null
  uptimeSeconds: number | null
  databaseRole: string | null
  openMode: string | null
  logMode: string | null
  protectionMode: string | null
  isCdb: boolean | null
  containerName: string | null
  conId: number | null
  characterSet: string | null
  nationalCharacterSet: string | null
  currentSchema: string
  sessionUser: string
  serverTypeInUse: string | null
  isRac: boolean | null
  instanceCount: number | null
  options: Record<string, boolean>
  privileges: { catalogAccess: boolean; dbaViews: boolean; vDollar: boolean }
  driver: { mode: 'thin' | 'thick'; version: string; clientVersion: string | null }
  unavailable: Record<string, string>
}

export type JobType = 'schema-apply' | 'data-generate' | 'quality' | 'benchmark' | 'cleanup'
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'

export interface JobProgress {
  phase: string
  done: number
  total: number
  unit: string
  ratePerSec?: number
  message?: string
}

export interface JobLogEntry {
  ts: string
  level: 'info' | 'warn' | 'error'
  msg: string
}

export interface JobRecord<C = any, R = any, K = any> {
  id: string
  type: JobType
  profileId: string
  title: string
  status: JobStatus
  config: C
  progress: JobProgress
  checkpoint: K | null
  result: R | null
  error: { message: string; code?: string } | null
  log: JobLogEntry[]
  resumable: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
}

export type JobSummary = Omit<JobRecord, 'log' | 'checkpoint' | 'result'> & { hasResult: boolean }

export interface PlannedStatement {
  seq: number
  objectType: string
  objectName: string
  sql: string
  /** Statement may fail harmlessly (e.g. optional feature); job continues and marks it skipped. */
  optional?: boolean
  note?: string
}

export interface SchemaPlan {
  id: string
  profileId: string
  schema: string
  blueprint: string
  options: SchemaOptions
  statements: PlannedStatement[]
  warnings: string[]
  versionMajor: number
  createdAt: string
  sha256: string
}

export interface SchemaOptions {
  prefix: string
  partitioning: 'none' | 'range' | 'interval' | 'list' | 'hash'
  includeLobs: boolean
  includePlsql: boolean
  includeMaterializedViews: boolean
  includeSynonyms: boolean
  compression: boolean
  extensionTables: number
  tablespace?: string
  historyStart: string
}

export type SizePreset = 'small' | 'medium' | 'large' | 'xl' | 'custom'

export interface GeneratorConfig {
  profileId: string
  schema: string
  prefix: string
  preset: SizePreset
  /** Number of orders; every other table scales from this. */
  orders: number
  seed: number
  batchSize: number
  commitEvery: number
  includeLobs: boolean
  historyStart: string
  historyEnd: string
  extensionRowsPerTable: number
}

export interface TableEstimate {
  table: string
  rows: number
  avgRowBytes: number
  bytes: number
}

export interface StorageEstimate {
  tables: TableEstimate[]
  totalRows: number
  tableBytes: number
  indexBytes: number
  lobBytes: number
  totalBytes: number
  note: string
}

export interface QualityCheckResult {
  id: string
  category: 'integrity' | 'duplicates' | 'nulls' | 'business-rule' | 'aggregate'
  title: string
  description: string
  status: 'pass' | 'fail' | 'error' | 'skipped'
  violations: number | null
  sql: string
  elapsedMs: number
  error?: string
}

export interface BenchmarkScenarioInfo {
  id: string
  no: number
  name: string
  category: 'write' | 'read' | 'mixed' | 'analytic'
  description: string
  writes: boolean
  defaultConcurrency: number
  requiresSchema: boolean
}

export interface BenchmarkConfig {
  profileId: string
  schema: string
  prefix: string
  scenarioId: string
  concurrency: number
  warmupSeconds: number
  durationSeconds: number
  thinkTimeMs: number
  batchSize: number
  readRatio: number
  label: string
  capturePlan: boolean
  /** Delete this run's BENCH_EVENTS rows afterwards (not timed). */
  cleanupAfter: boolean
  /** Explicit acknowledgement for write or high-concurrency runs. */
  confirmHeavy: boolean
}

export interface LatencySummary {
  count: number
  avgMs: number
  minMs: number
  maxMs: number
  p50Ms: number
  p95Ms: number
  p99Ms: number
}

export interface BenchmarkResult {
  scenario: BenchmarkScenarioInfo
  config: BenchmarkConfig
  startedAt: string
  finishedAt: string
  measuredSeconds: number
  operations: number
  rows: number
  opsPerSec: number
  rowsPerSec: number
  errors: number
  timeouts: number
  latency: LatencySummary
  timeline: { t: number; ops: number; p95Ms: number; errors: number }[]
  errorSamples: string[]
  plan: string | null
  environment: BenchmarkEnvironment
}

export interface BenchmarkEnvironment {
  oracleVersion: string
  banner: string
  edition: string
  instanceName: string | null
  isRac: boolean | null
  dbCpuCount: number | null
  dbPhysicalMemoryBytes: number | null
  appHost: { platform: string; cpus: number; cpuModel: string; totalMemBytes: number; node: string }
  driverMode: string
  dataSize: { table: string; rows: number | null }[]
  indexes: { table: string; index: string; columns: string }[]
}

export type AssessmentSeverity = 'critical' | 'warning' | 'info' | 'ok' | 'na'

/** One health-check outcome of the database assessment. `na` = could not be checked (privilege/version). */
export interface AssessmentFinding {
  id: string
  category: 'Recoverability' | 'Availability' | 'Security' | 'Capacity' | 'Performance' | 'Configuration' | 'Schema health'
  severity: AssessmentSeverity
  title: string
  detail: string
  recommendation?: string
  /** Up to 25 affected names (users, objects, parameters...). */
  items?: string[]
}

/** An assessment section is a set of independently collected panels. */
export type AssessmentSection = Record<string, Panel<any>>

export interface AuditEntry {
  id: string
  ts: string
  action: string
  profileId?: string
  target?: string
  detail?: string
  outcome: 'ok' | 'failed' | 'requested'
}

export interface LabSettings {
  driverMode: 'thin' | 'thick'
  driverVersion: string
  limits: {
    maxConcurrency: number
    maxBenchmarkSeconds: number
    heavyConcurrencyThreshold: number
    maxBatchSize: number
    maxRows: number
    maxConcurrentJobs: number
    maxExtensionTables: number
  }
  pool: { poolMax: number; poolMin: number; poolTimeout: number; callTimeoutMs: number }
  dataDir: string
  secretSource: 'env' | 'generated'
}
