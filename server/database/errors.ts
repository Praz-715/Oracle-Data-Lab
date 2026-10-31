// Normalizes node-oracledb / Oracle errors and explains the common ones.

export interface OracleErrorInfo {
  code: string
  message: string
  hint?: string
  /** True when the failure means "you can't see this", not "it broke". */
  unavailable: boolean
}

const HINTS: Record<string, { hint: string; unavailable?: boolean }> = {
  'ORA-00942': {
    hint: 'View or table not visible to this user. Grant SELECT on it (for V$ views: SELECT_CATALOG_ROLE or SELECT ANY DICTIONARY).',
    unavailable: true,
  },
  'ORA-01031': { hint: 'Insufficient privileges for this operation.', unavailable: true },
  'ORA-00904': { hint: 'Column not present in this Oracle version.', unavailable: true },
  'ORA-13516': { hint: 'AWR/diagnostic operation unavailable (license or configuration).', unavailable: true },
  'ORA-01017': { hint: 'Invalid username or password.' },
  'ORA-28000': { hint: 'The account is locked. Ask a DBA to unlock it.' },
  'ORA-28001': { hint: 'The password has expired. Change it with SQL*Plus first.' },
  'ORA-12541': { hint: 'No listener at host:port. Check host, port, firewall and that the listener is running.' },
  'ORA-12514': { hint: 'The listener does not know this service name. Check `lsnrctl services` or V$SERVICES.' },
  'ORA-12505': { hint: 'The listener does not know this SID. Try a Service Name instead.' },
  'ORA-12154': { hint: 'Connect identifier could not be resolved. Check the descriptor or TNS_ADMIN.' },
  'ORA-12170': { hint: 'Connection timed out. Check network routing and firewall rules.' },
  'ORA-12545': { hint: 'Target host unknown or unreachable.' },
  'ORA-28040': { hint: 'No matching authentication protocol. Older DBs may need Thick mode or SQLNET.ALLOWED_LOGON_VERSION changes.' },
  'ORA-01033': { hint: 'Oracle is starting up or shutting down.' },
  'ORA-01034': { hint: 'Oracle instance not available (not started).' },
  'ORA-65096': { hint: 'Common users in a CDB root must be prefixed C##. Connect to a PDB service for lab schemas.' },
  'ORA-00955': { hint: 'Object name already used by an existing object.' },
  'ORA-01653': { hint: 'Tablespace is full and cannot extend. Add space or enable autoextend.' },
  'ORA-01950': { hint: 'No quota on the tablespace. Grant QUOTA on the default tablespace.' },
  'ORA-00439': { hint: 'Feature not enabled in this edition (e.g. Partitioning requires Enterprise Edition).', unavailable: true },
  'ORA-01013': { hint: 'Call cancelled (timeout or user request).' },
  'NJS-138': { hint: 'Thin mode does not support this database version (Oracle 11g). Set NUXT_ORACLE_DRIVER_MODE=thick and install Oracle Instant Client.' },
  'NJS-116': { hint: 'Password verifier type not supported by Thin mode (10G verifier). Use Thick mode or reset the password with a newer verifier.' },
  'NJS-500': { hint: 'Connection to the database was lost.' },
  'NJS-501': { hint: 'Connection to the database was lost.' },
  'NJS-503': { hint: 'Connection to the listener refused or timed out. Check host, port and firewall.' },
  'NJS-510': { hint: 'Connection timed out. Check network and that the listener is reachable.' },
  'NJS-123': { hint: 'Advanced Queuing/feature not supported in Thin mode.' },
  'NJS-040': { hint: 'Connection request timed out waiting for a free pooled connection.' },
  'DPI-1047': { hint: 'Oracle Client libraries not found for Thick mode. Set NUXT_ORACLE_CLIENT_LIB_DIR.' },
}

export function oracleErrorInfo(err: unknown): OracleErrorInfo {
  const e = err as { message?: string; code?: string; errorNum?: number }
  const message = String(e?.message ?? err ?? 'Unknown error').split('\n')[0]!
  let code = e?.code ?? ''
  if (!code) {
    const m = /\b(ORA|NJS|DPI|TNS)-\d{3,5}\b/.exec(message)
    if (m) code = m[0]
  }
  if (!code && e?.errorNum) code = `ORA-${String(e.errorNum).padStart(5, '0')}`
  const h = HINTS[code]
  return { code: code || 'ERROR', message, hint: h?.hint, unavailable: !!h?.unavailable }
}

export function isUnavailableError(err: unknown): boolean {
  return oracleErrorInfo(err).unavailable
}
