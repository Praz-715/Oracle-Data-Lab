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

export type JobType = 'schema-apply' | 'data-generate' | 'quality' | 'benchmark' | 'cleanup' | 'import' | 'import-bundle' | 'import-undo'
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

// ---------------------------------------------------------------------------------------------
// Data sources & import
// ---------------------------------------------------------------------------------------------

export type SourceFormat = 'csv' | 'xlsx'

/** A file the importer can read: found in the datasets folder or uploaded through the UI. */
export interface DataSource {
  id: string
  name: string
  origin: 'folder' | 'upload'
  format: SourceFormat
  /** Display path relative to the datasets folder (folder sources) or the original file name. */
  path: string
  sizeBytes: number
  modifiedAt: string
  /** Cached profile summary, when the file has been profiled since it last changed. */
  rows?: number | null
  columns?: number | null
}

export type ColumnKind = 'integer' | 'decimal' | 'date' | 'timestamp' | 'text' | 'empty'

export interface ColumnProfile {
  index: number
  /** Header text (or COLn when the file has no header). */
  header: string
  /** Oracle-safe column name suggestion. */
  name: string
  kind: ColumnKind
  /** Suggested Oracle type, e.g. NUMBER(10), VARCHAR2(40 CHAR), DATE, TIMESTAMP(3). */
  oracleType: string
  /** Oracle conversion mask for date/timestamp columns. */
  dateMask: string | null
  /** Values use a decimal comma (1.234,56). */
  decimalComma: boolean
  nonNull: number
  nulls: number
  distinct: number
  distinctCapped: boolean
  maxLength: number
  maxBytes: number
  min: string | null
  max: string | null
  samples: string[]
  /** Text that looks numeric but must stay text (leading zeros, very long digit strings). */
  keepAsText: boolean
  /** Every non-null value is distinct (primary-key candidate). */
  unique: boolean
}

export interface SourceProfile {
  sourceId: string
  sheet: string | null
  sheets: string[]
  delimiter: string | null
  encoding: string
  hasHeader: boolean
  rows: number
  columns: ColumnProfile[]
  preview: (string | null)[][]
  profiledAt: string
  durationMs: number
}

export interface ImportColumn {
  /** Source column index; null with `constant` set inserts a fixed value. */
  source: number | null
  target: string
  /** Oracle type of the target column (used for CREATE TABLE and for conversion). */
  type: string
  dateMask?: string | null
  decimalComma?: boolean
  trim?: boolean
  emptyAsNull?: boolean
  constant?: string | null
}

export interface ImportConfig {
  profileId: string
  sourceId: string
  sheet?: string | null
  hasHeader: boolean
  delimiter?: string | null
  encoding?: string
  schema: string
  table: string
  mode: 'create' | 'append'
  columns: ImportColumn[]
  primaryKey?: string[]
  /** Adds/fills DL_IMPORT_ID so the rows of this import can be removed precisely. */
  tagRows: boolean
  batchSize: number
  /** Stop the job when more rows than this are rejected. */
  maxErrors: number
  gatherStats: boolean
}

export interface ImportPlan {
  schema: string
  table: string
  mode: 'create' | 'append'
  statements: { kind: 'create' | 'constraint' | 'index' | 'stats'; sql: string }[]
  insertSql: string
  preview: { row: number; values: (string | null)[]; issues: string[] }[]
  warnings: string[]
  errors: string[]
  totalRows: number | null
}

export interface ImportRejected {
  row: number
  error: string
  values: (string | null)[]
}

export interface ImportResult {
  schema: string
  table: string
  rowsRead: number
  inserted: number
  rejected: number
  rejectedSamples: ImportRejected[]
  tableCreated: boolean
  constraints: { sql: string; status: 'ok' | 'failed'; error?: string }[]
  seconds: number
}

/** Multi-file dataset pack described by a datasets/*.bundle.json manifest. */
export interface DatasetBundle {
  id: string
  name: string
  description: string
  license: string | null
  url: string | null
  tables: { file: string; table: string; sourceId: string | null; sizeBytes: number | null; primaryKey: string[] }[]
  missing: string[]
}

export type AssessmentSeverity ='critical' | 'warning' | 'info' | 'ok' | 'na'

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
    maxUploadMb: number
  }
  pool: { poolMax: number; poolMin: number; poolTimeout: number; callTimeoutMs: number }
  dataDir: string
  secretSource: 'env' | 'generated'
}
