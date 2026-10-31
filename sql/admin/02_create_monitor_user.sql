-- OracleDB Data Lab — read-only monitoring account (least privilege).
-- Use it in a "read-only" connection profile for Overview, Monitoring, Storage, SQL Tuning,
-- Diagnostics, RAC, Data Guard and RMAN pages. It cannot modify data.

CREATE USER lab_monitor IDENTIFIED BY "ChangeMe_2026#";
GRANT CREATE SESSION TO lab_monitor;

-- Read access to the data dictionary and dynamic performance (V$/GV$) views.
GRANT SELECT_CATALOG_ROLE TO lab_monitor;

-- Plan display for cursors in the shared pool (DBMS_XPLAN.DISPLAY_CURSOR) needs direct grants
-- on these views because roles are disabled inside definer-rights code paths.
GRANT SELECT ON sys.v_$session     TO lab_monitor;
GRANT SELECT ON sys.v_$sql         TO lab_monitor;
GRANT SELECT ON sys.v_$sql_plan    TO lab_monitor;
GRANT SELECT ON sys.v_$sql_plan_statistics_all TO lab_monitor;

-- Optional, 12c+: alert log entries for SQL Diagnostics.
-- GRANT SELECT ON sys.v_$diag_alert_ext TO lab_monitor;

-- To browse a lab schema's data from this account (Table Explorer sample rows):
-- GRANT SELECT ANY TABLE TO lab_monitor;   -- broad; prefer per-table grants in shared environments

-- NOT required and NOT used: AWR (DBA_HIST_*), ASH (V$ACTIVE_SESSION_HISTORY), V$METRIC*,
-- SQL Tuning Advisor. Those need the Diagnostics / Tuning Pack licenses.
