-- OracleDB Data Lab — optional extras for the lab schema owner.

-- The data generator reserves id ranges by temporarily changing INCREMENT BY on the lab's own
-- sequences. This works for the schema owner. If you connect as a DIFFERENT user that writes
-- into the lab schema, that user needs:
-- GRANT ALTER ANY SEQUENCE, SELECT ANY SEQUENCE, INSERT ANY TABLE, SELECT ANY TABLE TO <writer>;
-- (Broad privileges — only in isolated lab databases. Connecting as the schema owner is simpler.)

-- Free tablespace check in Data Generator preflight and Storage pages:
-- GRANT SELECT ON sys.dba_tablespace_usage_metrics TO lab;
-- GRANT SELECT ON sys.dba_tablespaces TO lab;
-- GRANT SELECT ON sys.dba_users TO lab;
