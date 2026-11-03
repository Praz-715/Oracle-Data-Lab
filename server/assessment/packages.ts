// PL/SQL packages the CIS benchmarks say PUBLIC should not have EXECUTE on. Used by the assessment
// check and by its Fix-it advice, so both always agree on the list.

export const SENSITIVE_PACKAGES = [
  'UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_MAIL', 'UTL_DBWS', 'UTL_ORAMTS', 'HTTPURITYPE', 'DBMS_LDAP',
  'DBMS_BACKUP_RESTORE', 'DBMS_JAVA', 'DBMS_JAVA_TEST', 'DBMS_ADVISOR', 'DBMS_CRYPTO', 'DBMS_JOB', 'DBMS_LOB',
  'DBMS_OBFUSCATION_TOOLKIT', 'DBMS_SCHEDULER', 'DBMS_SQL', 'DBMS_XMLGEN', 'DBMS_XMLQUERY',
]

/** The subset that reads server files or opens network connections (highest risk). */
export const NETWORK_FILE_PACKAGES = new Set(['UTL_FILE', 'UTL_HTTP', 'UTL_TCP', 'UTL_SMTP', 'UTL_INADDR', 'UTL_MAIL', 'HTTPURITYPE', 'DBMS_LDAP', 'DBMS_BACKUP_RESTORE', 'DBMS_JAVA'])
