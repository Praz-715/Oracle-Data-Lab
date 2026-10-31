-- OracleDB Data Lab — lab schema owner (run as a DBA in a PDB / non-CDB used for TESTING ONLY).
-- The app never creates users; create the schema it will write to here, then authorize it on a
-- "lab" mode connection profile. Adjust tablespace, quota and password before running.

-- In a CDB, connect to the PDB first:  ALTER SESSION SET CONTAINER = FREEPDB1;

CREATE USER lab IDENTIFIED BY "ChangeMe_2026#"
  DEFAULT TABLESPACE users
  TEMPORARY TABLESPACE temp
  QUOTA UNLIMITED ON users;

-- Objects the Schema Designer creates
GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE SEQUENCE, CREATE SYNONYM,
      CREATE PROCEDURE, CREATE TRIGGER, CREATE MATERIALIZED VIEW TO lab;

-- Optional: lets the lab user see V$ / DBA_ views for monitoring, storage and plan capture.
-- Prefer a separate monitoring account (02_create_monitor_user.sql) where possible.
-- GRANT SELECT_CATALOG_ROLE TO lab;
-- 11g/12c: SELECT_CATALOG_ROLE is not used by definer-rights PL/SQL; the app only queries directly.
