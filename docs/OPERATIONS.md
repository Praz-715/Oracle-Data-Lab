# OracleDB Data Lab — Operations Guide

Installation details, configuration, privileges, version/licensing constraints, safety model and
troubleshooting.

## 1. Requirements

- Node.js ≥ 20.11 (developed on 22.x), npm.
- An Oracle Database **for testing**. Run it separately (VM, container such as Oracle Database Free, or a
  shared lab server).
- Driver mode:
  - **Thin** (default, no Oracle Client): Oracle Database **12.1 and later**.
  - **Thick**: needed for **11g**, for 10G password verifiers (NJS-116) and some advanced network
    options. Install Oracle Instant Client and set:
    ```
    NUXT_ORACLE_DRIVER_MODE=thick
    NUXT_ORACLE_CLIENT_LIB_DIR=C:\oracle\instantclient_23_x   # Windows / macOS
    ```
    On Linux put Instant Client on the library path instead (`ldconfig`/`LD_LIBRARY_PATH`).
- Thin/thick is chosen once at server start. Restart after changing it.

## 2. Configuration

All settings are environment variables (see `.env.example`). Highlights:

| Variable | Default | Meaning |
| --- | --- | --- |
| `NUXT_LAB_SECRET` | generated | Key for AES-256-GCM encryption of saved passwords. If unset, a key is generated into `.data/lab/secret.key`. **Set it explicitly for any shared deployment** and back it up — without it saved passwords cannot be decrypted. |
| `NUXT_ORACLE_POOL_MAX` | 8 | Connections per profile for UI/monitoring/jobs. Benchmarks use a separate pool sized to their concurrency. |
| `NUXT_ORACLE_CALL_TIMEOUT_MS` | 120000 | Per round-trip timeout (long jobs use larger timeouts internally). |
| `NUXT_LIMITS_MAX_CONCURRENCY` | 32 | Hard cap on benchmark sessions. |
| `NUXT_LIMITS_HEAVY_CONCURRENCY_THRESHOLD` | 8 | Above this, a benchmark needs explicit confirmation (writes and analytic scans always do). |
| `NUXT_LIMITS_MAX_ROWS` | 100,000,000 | Max estimated rows for one generation job. |
| `NUXT_LIMITS_MAX_BATCH_SIZE` | 20,000 | Max rows per array-bound insert. |
| `NUXT_LIMITS_MAX_CONCURRENT_JOBS` | 2 | Jobs beyond this queue. |

App state lives in `.data/lab/` (profiles, jobs, DDL plans, audit log, storage snapshots). Back it up
together with `NUXT_LAB_SECRET`.

## 3. Database accounts & privileges

Use **two accounts** (scripts in `sql/admin/`):

1. **Lab schema owner** (`01_create_lab_user.sql`) — owns the generated objects. Use it in a profile set to
   *Lab — allow writes* with the schema listed under *Authorized schemas*. Needs CREATE TABLE/VIEW/
   SEQUENCE/SYNONYM/PROCEDURE/TRIGGER/MATERIALIZED VIEW and tablespace quota.
2. **Monitoring account** (`02_create_monitor_user.sql`) — `SELECT_CATALOG_ROLE` plus a few direct V$
   grants for plan display. Use it in a *read-only* profile for Overview, Monitoring, Storage, Tuning,
   Diagnostics, Database Assessment, RAC, Data Guard and RMAN.

**Database Assessment** reads only the data dictionary and V$ views. `SELECT_CATALOG_ROLE` covers almost
everything; the default-password check needs `DBA_USERS_WITH_DEFPWD` (SYS/DBA only) and shows *n/a*
otherwise. Connected to a **PDB** you see that container: `V$SPPARAMETER` lists only PDB-level settings
(the tab also shows the effective non-default parameters as init.ora text) and `V$RESOURCE_LIMIT` is
empty — connect a profile to `CDB$ROOT` to assess the instance-wide SPFILE and limits.
`DBA_FEATURE_USAGE_STATISTICS` is shown for information only; it is not a license determination.

When a view is not visible the panel shows **Unavailable** with the ORA code and what to grant — it never
falls back to placeholder numbers. Generator/benchmark/storage features degrade gracefully as well (e.g.
free-space check is skipped without DBA views).

Multitenant: connect to the **PDB service** (e.g. `FREEPDB1`, `ORCLPDB1`). Local users in a CDB root must
be `C##` common users (ORA-65096) — don't create lab schemas in the root.

## 4. Versions, editions and licensing

| Feature | Requirement | Behaviour when missing |
| --- | --- | --- |
| Partitioning (range/interval/list/hash) | Partitioning option (Enterprise Edition; check `V$OPTION` on Free/XE builds) | Designer detects `V$OPTION` and falls back to non-partitioned DDL with a warning |
| Basic table compression | Enterprise Edition | Statements marked optional/skipped |
| Materialized views, synonyms | `CREATE MATERIALIZED VIEW` / `CREATE SYNONYM` | Optional statements, skipped if refused |
| OFFSET/FETCH paging | 12c+ | 11g uses ROWNUM automatically |
| `V$DIAG_ALERT_EXT` (alert log) | 12c+ | 11g: paste alert-log text into the analyzer |
| Identifier length 128 | 12.2+ | Blueprint names always fit in 30 characters |
| RAC / Data Guard / RMAN panels | The corresponding setup | Panels explain they don't apply |

**Licensed packs are not used.** No AWR (`DBA_HIST_*`), ASH (`V$ACTIVE_SESSION_HISTORY`), `V$METRIC*` or
SQL Tuning Advisor queries are issued. Monitoring uses `V$SYSSTAT`, `V$OSSTAT`, `V$SESSION`,
`V$SYSTEM_EVENT`, `V$SQLSTATS`, `V$SQL_PLAN`, `V$SQL_BIND_CAPTURE` etc., and rates are computed from
consecutive samples. Verify licensing for your own environment.

## 5. Safety model

- **Read-only by default.** Every write path (DDL apply, data generation, write benchmarks, cleanup)
  checks that the profile is in *lab* mode **and** the target schema is explicitly authorized.
- **Review before execution.** DDL is planned, shown and exported first; apply sends the SHA-256 of the
  reviewed plan and the server refuses if it differs. Applying requires typing the schema name.
- **Never drops users/schemas, never truncates.** Cleanup deletes rows by `DL_JOB_ID` (generation job)
  or `RUN_ID` (benchmark), or drops prefixed lab objects after typed confirmation. Shared reference rows
  still referenced elsewhere are kept (ORA-02292 is reported, not forced).
- **Limits and confirmation** on concurrency, duration, batch size, rows and concurrent jobs.
  Write/analytic/high-concurrency benchmarks require explicit confirmation.
- **Credentials** are only accepted server-side, encrypted at rest, never returned to the browser and
  never written to logs or the audit trail. The browser stores only the selected profile id.
- **Audit log** (Settings) records profile changes, plan applies, generation, benchmarks, cleanup,
  cancel/resume.
- **Security**: the app has no login of its own. State-changing API calls require an `x-odl-client`
  header (blocks cross-site form posts). Run it on localhost or behind an authenticating reverse proxy.
- SQL Tuning *Measure* runs only a single `SELECT`/`WITH` inside `SET TRANSACTION READ ONLY`.

## 6. Data generator internals

- Volume is driven by **orders**; customers ≈ orders/8, products ≈ orders/200 (500–50,000), suppliers
  ≈ products/25. Presets target ~100k / 1M / 10M / 50M total rows.
- IDs are reserved from each table's sequence in one block (temporary `INCREMENT BY n`), so generated
  rows coexist with later sequence-based inserts and several jobs can append to the same schema.
- Every row is derived from `(seed, stream, row index)`. A resumed job regenerates exactly the rows it
  would have produced, starting from the last committed checkpoint.
- Realism: monthly seasonality with 11.11/12.12 campaign spikes, paydays, weekday and intraday curves,
  yearly growth, long-tenured customers buying more (power-law), product popularity skew, channel mix
  shifting to mobile, order status by age, ~3% line returns, split payments.
- Guaranteed rules (and validated by Data Quality): valid FKs; ≥1 line per order; unit price within the
  product's MIN/MAX price; order subtotal/total reconcile to the cent; captured payments equal the order
  total for delivered/returned orders; shipped ≥ order date; delivered ≥ shipped; return qty ≤ purchased;
  inventory on hand = signed sum of movements and never negative; customers order only after signing up.
- Personal data is synthetic: names are random combinations, emails use reserved `example.*` domains,
  phone numbers use a fictional 555 block.
- LOBs: review bodies ≤ 3,900 chars and images ≤ 2,000 bytes so they bind in-line on every version.

## 7. Benchmarks

- Each run records scenario, configuration, Oracle version/edition/instance, DB host CPUs/memory
  (`V$OSSTAT`), app host, driver mode, table row counts (statistics) and indexes — so results stay
  comparable.
- Latencies are client-observed round trips (incl. network), recorded in a log-bucket histogram (~1%
  error). Warm-up operations are excluded.
- Write scenarios only touch `<prefix>BENCH_EVENTS` and delete their rows afterwards unless disabled.
- Plan capture prefers the real cursor plan (`DBMS_XPLAN.DISPLAY_CURSOR`), else `EXPLAIN PLAN`.
- For RAC-vs-single-instance or version comparisons, run the same scenario/data size on each target and
  compare in *History & compare*.

## 7a. Data sources & imports

- **Sources.** Files under `NUXT_DATASETS_DIR` (default `./datasets`, scanned recursively for
  `.csv/.tsv/.txt/.xlsx`) are read-only and addressed by opaque ids. Uploads are streamed to
  `NUXT_DATASETS_UPLOAD_DIR` (default `./.data/uploads`), limited by `NUXT_LIMITS_MAX_UPLOAD_MB`
  (default 512). `datasets/raw/` is git-ignored.
- **Profiling** scans the whole file once (≈60k rows/s for CSV) and is cached until the file changes:
  delimiter and UTF-8/Latin-1 encoding are sniffed, BOMs and quoted newlines are handled, Excel date
  cells are recognized from their number format. Type inference: integers → `NUMBER(p)`, decimals →
  `NUMBER(p,s)` (decimal comma supported), dates → `DATE`/`TIMESTAMP(n)` with an Oracle mask
  (ISO, `DD/MM/YYYY`, `MM/DD/YYYY`, `-`/`.` separators), anything with leading zeros or > 38 digits
  stays text, text → `VARCHAR2(n CHAR)` (exact length for fixed-width codes) or `CLOB` beyond 4000 bytes.
- **Imports** only create new tables or append — never truncate or replace. Values are bound as strings
  and converted by Oracle (`TO_NUMBER`, `TO_DATE(…, mask)`) with `NLS_NUMERIC_CHARACTERS='.,'`, so the
  first rows can be validated in Oracle before running, and rejected rows carry the real ORA error
  (`executeMany` with `batchErrors`). The job stops once rejects exceed the configured limit; committed
  rows stay. Resume continues after the last committed batch and refuses if the file changed.
- **Undo:** with row tagging on (default), *Delete imported rows* removes `DL_IMPORT_ID = <job id>`;
  imports that created a table (and bundle imports) can drop what they created. Both require typing
  the table name / prefix.
- **Bundles:** a `datasets/<name>.bundle.json` manifest lists files, table names, column renames/types,
  primary keys, foreign keys and indexes; keys and statistics are created after all tables are loaded.
  The included **Olist** manifest (CC BY-NC-SA 4.0) loads ~1.55M rows into 9 related tables.
- In `npm run dev`, editing server files restarts Nitro and marks a running import *interrupted* —
  resume it from Job History or the Import Manager.

## 8. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `NJS-138` | Thin mode cannot talk to 11g → thick mode + Instant Client. |
| `NJS-116` | Password uses a 10G verifier → thick mode or reset the password on a newer verifier. |
| `DPI-1047` | Thick mode can't find Instant Client → `NUXT_ORACLE_CLIENT_LIB_DIR`. |
| `NJS-503` / `ORA-12541` | Listener unreachable → host/port/firewall/listener status. |
| `ORA-12514` | Wrong service name → `lsnrctl services` or `SELECT name FROM v$services`. |
| `ORA-01017` | Wrong user/password (or case-sensitive password). |
| `ORA-65096` | Trying to create a local user in CDB root → connect to the PDB. |
| `ORA-00439` | Feature not enabled (Partitioning/compression on SE2) → choose *None* / untick compression. |
| `ORA-01950` / `ORA-01653` | Quota / tablespace full → grant quota, add datafile or enable autoextend. |
| Panel says *Unavailable* `ORA-00942` | Missing view privilege → see §3. |
| Job shows *interrupted* | Server restarted mid-run → *Resume* in Job History continues from the last checkpoint. |
| Benchmark errors `NJS-040` | Pool queue timeout → lower concurrency or raise limits. |

## 9. Testing

- `npm test` — unit tests: deterministic generation & resume, every business rule on a generated batch,
  DDL ordering/naming/partitioning, histogram accuracy, scenario SQL/binds, analyzers.
- `npm run test:integration` — applies the real DDL and loads a small dataset into a disposable schema,
  then checks rules in SQL. Needs `ODL_TEST_CONNECT_STRING`, `ODL_TEST_USER`, `ODL_TEST_PASSWORD`; drops
  its `ZT_` objects afterwards.

## 10. Roadmap status

- **Phase 1 — Core platform:** done (connections, schema/object generator, data generator, explorer,
  quality validator, jobs, UI shell, theming, motion with reduced-motion support).
- **Phase 2 — Performance lab:** done (18 scenarios, percentiles, plans, history/compare, export).
- **Phase 3 — Monitoring:** done except Prometheus/Grafana integration (planned).
- **Phase 4 — Enterprise HA/DR:** read-only RAC/Data Guard/RMAN observability done; drills, schema
  compare/migration, workload replay and multiversion lab are planned.
