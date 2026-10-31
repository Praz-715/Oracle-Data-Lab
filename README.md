# OracleDB Data Lab

Platform for **testing, benchmarking, synthetic data generation and observability** of Oracle Database
(11g, 12c, 19c, 21c, 26ai). Built with Nuxt 4 + Vue 3 + TypeScript, Motion for Vue (`motion-v`) and
`node-oracledb`. All Oracle access happens server-side; the browser never connects to the database.

Specs: [`docs/build_this.md`](docs/build_this.md) · [`docs/my_target.md`](docs/my_target.md) ·
Operations, privileges, licensing & troubleshooting: [`docs/OPERATIONS.md`](docs/OPERATIONS.md)

## Quick start

```bash
npm install
cp .env.example .env          # optional: set NUXT_LAB_SECRET, driver mode, limits
npm run dev                   # http://localhost:3000
```

1. Create the lab schema and (optionally) a monitoring user with the scripts in [`sql/admin/`](sql/admin).
2. **Connections** → *New connection*. Profiles are **read-only** by default. For the lab schema, switch to
   **Lab — allow writes** and list the schema under *Authorized schemas*.
3. **Schema Designer** → generate the DDL plan, review it, apply (type the schema name to confirm).
4. **Data Generator** → pick a size preset → *Preflight* → *Generate*. Progress streams live; jobs are resumable.
5. **Data Quality** → run the 24 integrity / business-rule checks.
6. **Performance Lab** → run any of the 18 scenarios; compare runs in *History & compare*.

Production build: `npm run build && node .output/server/index.mjs` (set `PORT`/`HOST` as needed).
Keep it on a trusted network — the app has no user login of its own (see OPERATIONS → Security).

## What is built

| Area | Status | Notes |
| --- | --- | --- |
| Connection & environment manager | ✅ | Service name / SID / descriptor, dedicated/shared/DRCP, TLS wallet, SYSDBA etc.; version, edition, CDB/PDB, role, charset, uptime, options; pool monitoring; error diagnostics |
| Schema & object generator | ✅ | 17 core tables + up to 300 extension tables; PK/FK/UK/CHECK, (composite/local) indexes, views, MVs, sequences, synonyms, package, procedure, function, triggers, range/interval/list/hash partitioning, CLOB/BLOB; DDL preview, export, SHA-checked apply, per-object status |
| Synthetic data generator | ✅ | Presets 100k / 1M / 10M / 50M rows or custom; array binding, batch commits, deterministic seed, resume, storage estimate, seasonality & skew, business rules, rows tagged by job id |
| Data quality validator | ✅ | Orphans, duplicates, NULLs, business rules, aggregates; optional per-job scope |
| Table / schema explorer | ✅ | Columns, constraints, indexes, partitions, sample rows (11g-safe paging), DDL, inventory, dependencies, ERD |
| Performance & SQL benchmark lab | ✅ | 18 scenarios, warm-up, concurrency, duration, p50/p95/p99, timeline, plan capture, environment capture, history/compare, CSV/JSON export, confirmation for heavy runs |
| Database assessment | ✅ | All parameters, SPFILE contents + effective init.ora, users, profiles (limit matrix), roles & powerful grants, PUBLIC package grants, DB links, directories, auditing, tablespaces/datafiles, objects by type/owner, invalid objects, schema health (stats, unindexed FKs, missing PKs, unusable indexes), redo/control files/archive/FRA, SGA/PGA, PDBs, components, patches, feature usage; ~36 automated health checks; standalone HTML / JSON report |
| Instance & session monitoring | ✅ | Sessions, CPU (V$OSSTAT), SGA/PGA, buffer cache, shared pool, library cache, waits, blocking/locks, redo, reads, long ops, TEMP |
| Tablespaces & storage | ✅ | Tablespaces, datafiles, table/index/LOB sizes (measured vs estimated), segments, TEMP, UNDO, growth snapshots + capacity forecast |
| SQL tuning workbench | ✅ | Top SQL, SQL_ID stats/plan/binds/child cursors, literal-SQL detection, EXPLAIN PLAN, before/after timing, heuristic index hints |
| SQL diagnostics (ORA analyzer) | ✅ | Alert log (12c+) and pasted text grouped by ORA/TNS code with guidance |
| Visual analytics | ✅ | Revenue, orders, channels, categories, status, weekday, top customers from the lab tables |
| RAC / Data Guard / RMAN | ✅ read-only | Observability panels; failover/switchover/restore drills intentionally not executed yet |
| Job history & cleanup manager | ✅ | Persistent jobs, SSE progress, cancel/resume, cleanup by job id / run id / prefix with typed confirmation, audit log |
| Dataset sources, import manager, Prometheus/Grafana, schema compare, workload replay, multiversion lab | 🗺️ planned | Shown as *planned* in the UI, never simulated |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` / `npm start` | Production build / run |
| `npm run typecheck` | Vue + server type checking |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm test` | Unit tests (generators, DDL, histogram, scenarios, analyzers) — no database needed |
| `npm run test:integration` | Real Oracle run against a disposable schema (`ODL_TEST_*` env vars) |

## Project layout

```
app/                 Nuxt app (pages, components, composables, CSS tokens)
server/api/          HTTP routes (thin: validate → service)
server/services/     Connection profiles, schema plans, generator, quality, benchmark, monitoring, storage, ...
server/database/     node-oracledb driver/pools, environment detection, error mapping, bulk insert
server/generators/   Blueprint, DDL builder, deterministic data model, storage estimate
server/benchmarks/   Scenarios and latency histogram
server/jobs/         Background job runner (persisted, resumable, SSE)
shared/types/        Types shared by browser and server
sql/admin/           Grant scripts for lab and monitoring users
tests/               Unit and integration tests
.data/lab/           Local store: profiles (encrypted passwords), jobs, plans, audit (git-ignored)
```
