import sql from 'mssql';
import { afterCommit, getDbPool } from '../db/dbconfig.js';
import { auditLogger, securityLogger } from '../logger/logger.js';
import { dataChangesTotal } from '../metrics/metrics.js';
import { currentRequestMeta } from '../utils/request-context.js';
import { toOffset } from '../utils/pagination.js';

/**
 * Audit trail.
 *
 * Two records are kept in the database for the Head of ICT:
 *   AuditLogs  - every create / update / delete of business data (writeAudit)
 *   AuthEvents - logins, failed logins, password changes (recordAuthEvent)
 *
 * Both also produce a log line (channels "audit" / "security") carrying the
 * same request_id, so database records, log files and the X-Request-Id
 * response header can all be matched up.
 */

export type AuditAction = 'CREATE' | 'UPDATE' | 'DELETE';

export interface AuditEntry {
    userId: number;
    action: AuditAction;
    entity: string;        // table name, e.g. 'Procurements'
    entityId: number;
    oldValues?: unknown;   // record before the change (UPDATE / DELETE)
    newValues?: unknown;   // record after the change (CREATE / UPDATE)
}

/**
 * Writes one audit entry.
 * The log line and metric are emitted only after the transaction commits, so a
 * rolled-back change never appears as if it happened.
 * @param executor the pool, or a transaction so the entry commits/rolls back with the change
 */
export const writeAudit = async (
    executor: sql.ConnectionPool | sql.Transaction,
    entry: AuditEntry,
): Promise<void> => {
    const meta = currentRequestMeta();

    await new sql.Request(executor as sql.ConnectionPool)
        .input('user_id', sql.Int, entry.userId)
        .input('action', sql.NVarChar(10), entry.action)
        .input('entity', sql.NVarChar(50), entry.entity)
        .input('entity_id', sql.Int, entry.entityId)
        .input('old_values', sql.NVarChar(sql.MAX), entry.oldValues === undefined ? null : JSON.stringify(entry.oldValues))
        .input('new_values', sql.NVarChar(sql.MAX), entry.newValues === undefined ? null : JSON.stringify(entry.newValues))
        .input('request_id', sql.NVarChar(64), meta.request_id)
        .input('ip_address', sql.NVarChar(45), meta.ip_address)
        .query(`INSERT INTO dbo.AuditLogs (user_id, action, entity, entity_id, old_values, new_values, request_id, ip_address)
                VALUES (@user_id, @action, @entity, @entity_id, @old_values, @new_values, @request_id, @ip_address)`);

    afterCommit(executor, () => {
        // Values are kept in the database only; the log line just says what changed
        auditLogger.info(
            { user_id: entry.userId, action: entry.action, entity: entry.entity, entity_id: entry.entityId, ...meta },
            `${entry.action} ${entry.entity}#${entry.entityId} by user ${entry.userId}`,
        );
        dataChangesTotal.inc({ entity: entry.entity, action: entry.action });
    });
};

export type AuthEventType = 'LOGIN_SUCCESS' | 'LOGIN_FAILED' | 'PASSWORD_CHANGED' | 'PASSWORD_RESET';

export interface AuthEvent {
    eventType: AuthEventType;
    userId: number | null;     // null when the email did not match any account
    email?: string | null;
    reason?: string | null;    // e.g. wrong_password - stored for audit, never sent to the caller
}

/**
 * Records a login / password event in AuthEvents and the security log.
 * A failure to write the record is logged but never breaks the login itself.
 */
export const recordAuthEvent = async (event: AuthEvent): Promise<void> => {
    const meta = currentRequestMeta();
    const logEntry = { event: event.eventType, user_id: event.userId, email: event.email ?? null, reason: event.reason ?? null, ...meta };

    if (event.eventType === 'LOGIN_FAILED') securityLogger.warn(logEntry, `Login failed (${event.reason})`);
    else securityLogger.info(logEntry, event.eventType.replace('_', ' ').toLowerCase());

    try {
        await getDbPool().request()
            .input('user_id', sql.Int, event.userId)
            .input('email', sql.NVarChar(150), event.email ?? null)
            .input('event_type', sql.NVarChar(30), event.eventType)
            .input('reason', sql.NVarChar(100), event.reason ?? null)
            .input('ip_address', sql.NVarChar(45), meta.ip_address)
            .input('user_agent', sql.NVarChar(400), meta.user_agent)
            .input('request_id', sql.NVarChar(64), meta.request_id)
            .query(`INSERT INTO dbo.AuthEvents (user_id, email, event_type, reason, ip_address, user_agent, request_id)
                    VALUES (@user_id, @email, @event_type, @reason, @ip_address, @user_agent, @request_id)`);
    } catch (err) {
        securityLogger.error({ err, ...logEntry }, 'Could not save auth event to the database');
    }
};

export interface AuthEventFilters {
    page: number;
    limit: number;
    user_id?: number;
    event_type?: AuthEventType;
    from?: string;
    to?: string;
}

/** Paginated login history, newest first. */
export const listAuthEventsService = async (filters: AuthEventFilters) => {
    const db = getDbPool();
    const where = `WHERE (@user_id IS NULL OR e.user_id = @user_id)
                     AND (@event_type IS NULL OR e.event_type = @event_type)
                     AND (@from IS NULL OR e.created_at >= @from)
                     AND (@to IS NULL OR e.created_at < DATEADD(DAY, 1, @to))`;

    const result = await db.request()
        .input('user_id', sql.Int, filters.user_id ?? null)
        .input('event_type', sql.NVarChar(30), filters.event_type ?? null)
        .input('from', sql.Date, filters.from ?? null)
        .input('to', sql.Date, filters.to ?? null)
        .input('offset', sql.Int, toOffset(filters.page, filters.limit))
        .input('limit', sql.Int, filters.limit)
        .query(`
            SELECT COUNT(*) AS total FROM dbo.AuthEvents e ${where};

            SELECT e.event_id, e.event_type, e.reason, e.user_id, u.full_name AS user_name, e.email,
                   e.ip_address, e.user_agent, e.request_id, e.created_at
            FROM dbo.AuthEvents e
            LEFT JOIN dbo.Users u ON u.user_id = e.user_id
            ${where}
            ORDER BY e.event_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

export interface AuditLogFilters {
    page: number;
    limit: number;
    entity?: string;
    entity_id?: number;
    user_id?: number;
}

/** Paginated audit log, newest first, with optional filters. */
export const listAuditLogsService = async (filters: AuditLogFilters) => {
    const db = getDbPool();
    const where = `WHERE (@entity IS NULL OR a.entity = @entity)
                     AND (@entity_id IS NULL OR a.entity_id = @entity_id)
                     AND (@user_id IS NULL OR a.user_id = @user_id)`;

    const result = await db.request()
        .input('entity', sql.NVarChar(50), filters.entity ?? null)
        .input('entity_id', sql.Int, filters.entity_id ?? null)
        .input('user_id', sql.Int, filters.user_id ?? null)
        .input('offset', sql.Int, toOffset(filters.page, filters.limit))
        .input('limit', sql.Int, filters.limit)
        .query(`
            SELECT COUNT(*) AS total FROM dbo.AuditLogs a ${where};

            SELECT a.audit_id, a.action, a.entity, a.entity_id, a.old_values, a.new_values,
                   a.request_id, a.ip_address, a.created_at,
                   a.user_id, u.full_name AS user_name
            FROM dbo.AuditLogs a
            LEFT JOIN dbo.Users u ON u.user_id = a.user_id
            ${where}
            ORDER BY a.audit_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return {
        total: recordsets[0][0].total as number,
        rows: recordsets[1],
    };
};
