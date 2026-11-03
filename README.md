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
   **Lab — allow writes** and list the schema under *Authorized schemas*. Diagnostics Pack (AWR/ASH) stays
   off unless you confirm the target is licensed.
3. Get data, either way:
   - **Schema Designer** → generate the DDL plan, review it, apply (type the schema name to confirm), then
     **Data Generator** → pick a size preset → *Preflight* → *Generate* (live progress, resumable jobs);
   - or **Dataset Sources** / **Import Manager** → import the Olist e-commerce bundle from `datasets/raw/`
     or your own CSV/XLSX files with column mapping.
4. **Data Quality** → run the 24 integrity / business-rule checks.
5. **Performance Lab** → run any of the 26 scenarios (18 synthetic retail + 8 on Olist); compare runs in
   *History & compare*.
6. **Database Assessment** → inventory and ~36 health checks; **Fix it** turns each finding into a
   reviewed script (advice only), *History & compare* tracks changes over time.
7. **SQL Playground** / **SQL Tuning** → run and compare queries with actual plans, get index
   recommendations for the slowest SQL and test them as INVISIBLE indexes.

Production build: `npm run build && node .output/server/index.mjs` (set `PORT`/`HOST` as needed).
Keep it on a trusted network — the app has no user login of its own (see OPERATIONS → Security).

## What is built

| Area | Status | Notes |
| --- | --- | --- |
| Overview dashboard | ✅ | Active sessions, host CPU (V$OSSTAT) and SQL throughput of the selected database at a glance |
| Connection & environment manager | ✅ | Service name / SID / descriptor, dedicated/shared/DRCP, TLS wallet, SYSDBA etc.; version, edition, CDB/PDB, role, charset, uptime, options; pool monitoring; error diagnostics |
| Schema & object generator | ✅ | 17 core tables + up to 300 extension tables; PK/FK/UK/CHECK, (composite/local) indexes, views, MVs, sequences, synonyms, package, procedure, function, triggers, range/interval/list/hash partitioning, CLOB/BLOB; DDL preview, export, SHA-checked apply, per-object status |
| Synthetic data generator | ✅ | Presets 100k / 1M / 10M / 50M rows or custom; array binding, batch commits, deterministic seed, resume, storage estimate, seasonality & skew, business rules, rows tagged by job id |
| Data quality validator | ✅ | Orphans, duplicates, NULLs, business rules, aggregates; optional per-job scope |
| Table / schema explorer | ✅ | Columns, constraints, indexes, partitions, sample rows (11g-safe paging), DDL, inventory, dependencies, ERD |
| Performance & SQL benchmark lab | ✅ | 18 synthetic-retail scenarios + 8 read-only scenarios on the imported Olist data (order page, customer history, 1M-row zip lookup, seller dashboard, category report, delivery SLA, review search, storefront mix); per-run database activity via ASH-lite (AAS by wait class, top SQL/events) and, for licensed profiles, AWR snapshots/report + Oracle ASH; warm-up, concurrency, duration, p50/p95/p99, timeline, plan capture, environment capture, history/compare, CSV/JSON export, confirmation for heavy runs |
| Database assessment | ✅ | All parameters, SPFILE contents + effective init.ora, users, profiles (limit matrix), roles & powerful grants, PUBLIC package grants, DB links, directories, auditing, tablespaces/datafiles, objects by type/owner, invalid objects, schema health (stats, unindexed FKs, missing PKs, unusable indexes), redo/control files/archive/FRA, SGA/PGA, PDBs, components, patches, feature usage; ~36 automated health checks; standalone HTML / JSON report |
| Fix-it recommendations | ✅ advice only | Per health check and as a whole-database plan: scripts built from facts read from the database (paths, OMF/ASM, common grants, dependencies, existing names), with run-as context, impact (restart/downtime/EE/risk), placeholders, verify and rollback; `.sql` runbook and HTML download. Never executed by the app |
| Assessment history & compare | ✅ | Snapshots of the full assessment; trends of issues, size and invalid objects; compare any two snapshots (same database over time or two databases): identity, counts, health checks appeared/resolved/worse/better, and per-area changes (parameters, SPFILE, users, profiles, grants, tablespaces, objects, schema health, redo/archive, NLS/properties, components, patches, options); HTML comparison report |
| Diagnostics Pack (optional) | ✅ opt-in | License-free ASH-lite (V$SESSION sampling) is the default everywhere; AWR snapshots/reports and Oracle ASH only for profiles where you explicitly confirm a Diagnostics Pack license (strong warning, recorded with a timestamp, revocable) |
| Instance & session monitoring | ✅ | Live *Top activity* (ASH-lite or licensed Oracle ASH), sessions, CPU (V$OSSTAT), SGA/PGA, buffer cache, shared pool, library cache, waits, blocking/locks, redo, reads, long ops, TEMP |
| Tablespaces & storage | ✅ | Tablespaces, datafiles, table/index/LOB sizes (measured vs estimated), segments, TEMP, UNDO, growth snapshots + capacity forecast |
| SQL Playground | ✅ | Read-only SELECT/WITH with schema context and bind variables; actual plan (DBMS_XPLAN ALLSTATS LAST: A-Rows, Buffers per step), autotrace-style session statistics, A/B comparison of runs, saved queries, Olist example queries |
| Index Advisor | ✅ | License-free: reads plan predicates + column statistics, proposes B-tree indexes for selective filters and join probes, flags index-defeating predicates (functions such as TRUNC/LOWER, implicit conversions, leading wildcards); tests a candidate as an INVISIBLE index with before/after cost, time and logical reads, then keep (visible) or drop |
| SQL tuning workbench | ✅ | Top SQL, SQL_ID stats/plan/binds/child cursors, literal-SQL detection, EXPLAIN PLAN, before/after timing; index recommendations for the slowest application SQL from their real cursor plans, merged across statements and ranked by share of SQL time (test in the Playground) |
| SQL diagnostics (ORA analyzer) | ✅ | Alert log (12c+) and pasted text grouped by ORA/TNS code with guidance |
| Visual analytics | ✅ | Revenue, orders, channels, categories, status, weekday, top customers from the lab tables |
| RAC / Data Guard / RMAN | ✅ read-only | Observability panels; failover/switchover/restore drills intentionally not executed yet |
| Job history & cleanup manager | ✅ | Persistent jobs, SSE progress, cancel/resume, cleanup by job id / run id / prefix with typed confirmation, audit log |
| Dataset sources | ✅ | Files in `datasets/` + CSV/TSV/XLSX uploads (streamed, size-limited); full-file profiling with Oracle type inference (numbers, decimal comma, date masks, codes with leading zeros kept as text, unique-key candidates); preview; bundle manifests (`datasets/*.bundle.json`) such as the Olist e-commerce pack with PKs, FKs and indexes |
| Import manager | ✅ | Create a table from inferred types or append to an existing one; column mapping, type/mask/decimal-comma/constant per column; first rows validated by Oracle before running; resumable job with array binds, per-row rejects (ORA error + values), rows tagged `DL_IMPORT_ID`, PK + statistics after load; undo by deleting tagged rows or dropping created tables (typed confirmation) |
| Prometheus/Grafana, schema compare, workload replay, multiversion lab | 🗺️ planned | Not built yet (and never simulated) |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Dev server with HMR |
| `npm run build` / `npm start` | Production build / run |
| `npm run typecheck` | Vue + server type checking |
| `npm run lint` / `npm run format` | ESLint / Prettier |
| `npm test` | Unit tests (generators, DDL, histogram, scenarios, importer, ASH-lite, index advisor, assessment diff, fix-it scripts) — no database needed |
| `npm run test:integration` | Real Oracle run against a disposable schema (`ODL_TEST_*` env vars) |

## Project layout

```
app/                 Nuxt app (pages, components, composables, CSS tokens)
server/api/          HTTP routes (thin: validate → service)
server/services/     Connection profiles, schema plans, generator, quality, benchmark, monitoring, storage, ...
server/database/     node-oracledb driver/pools, environment detection, error mapping, bulk insert
server/generators/   Blueprint, DDL builder, deterministic data model, storage estimate
server/benchmarks/   Scenarios and latency histogram
server/recommend/    Fix-it advice (per health check) and SQL index recommendations — scripts only, never executed
server/tuning/       Index advisor heuristics (plan predicates → candidates)
server/assessment/   Snapshot diff for assessment history & compare
server/jobs/         Background job runner (persisted, resumable, SSE)
datasets/            Dataset files and bundle manifests (datasets/raw/ is git-ignored)
shared/types/        Types shared by browser and server
sql/admin/           Grant scripts for lab and monitoring users
tests/               Unit and integration tests
.data/lab/           Local store: profiles (encrypted passwords), jobs, plans, audit (git-ignored)
```
