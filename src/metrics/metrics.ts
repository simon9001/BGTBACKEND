import { prometheus } from '@hono/prometheus';
import { Counter, Gauge, Registry } from 'prom-client';
import { getDbPool } from '../db/dbconfig.js';

/**
 * Prometheus metrics.
 *
 * Everything is registered on one shared registry and exposed at GET /metrics.
 * All metric names start with "bgt_".
 *
 * Standard (from @hono/prometheus + prom-client):
 *   bgt_http_requests_total{method,route,status,ok}       request count
 *   bgt_http_request_duration_seconds{...}                 response time histogram
 *   bgt_process_* / bgt_nodejs_*                           CPU, memory, event loop, GC
 *
 * Application-specific (defined below):
 *   bgt_auth_logins_total{result}                          successful / failed logins
 *   bgt_auth_denied_total{reason}                          rejected tokens and permission denials
 *   bgt_data_changes_total{entity,action}                  creates / updates / deletes per table
 *   bgt_app_errors_total{type}                             unexpected (500) errors
 *   bgt_db_pool_connections{state}                         SQL connection pool usage
 */

export const registry = new Registry();

// HTTP request metrics middleware + the handler that prints all metrics
export const { registerMetrics, printMetrics } = prometheus({
    registry,
    prefix: 'bgt_',
    collectDefaultMetrics: true,
});

/** Login attempts. result: success | invalid_credentials | deactivated */
export const authLoginsTotal = new Counter({
    name: 'bgt_auth_logins_total',
    help: 'Login attempts by result',
    labelNames: ['result'] as const,
    registers: [registry],
});

/** Refused requests. reason: missing_token | expired_token | invalid_token | inactive_user | forbidden_role | not_owner */
export const authDeniedTotal = new Counter({
    name: 'bgt_auth_denied_total',
    help: 'Requests rejected by authentication or authorization',
    labelNames: ['reason'] as const,
    registers: [registry],
});

/** Committed data changes, counted from the audit trail. */
export const dataChangesTotal = new Counter({
    name: 'bgt_data_changes_total',
    help: 'Created, updated and deleted records by table',
    labelNames: ['entity', 'action'] as const,
    registers: [registry],
});

/** Unexpected errors that returned HTTP 500. */
export const appErrorsTotal = new Counter({
    name: 'bgt_app_errors_total',
    help: 'Unhandled application errors',
    labelNames: ['type'] as const,
    registers: [registry],
});

/** SQL connection pool usage, read at scrape time. */
new Gauge({
    name: 'bgt_db_pool_connections',
    help: 'MSSQL connection pool: total size, idle (available), in use (borrowed), waiting requests (pending)',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
        try {
            const pool = getDbPool();
            this.set({ state: 'size' }, pool.size);
            this.set({ state: 'available' }, pool.available);
            this.set({ state: 'borrowed' }, pool.borrowed);
            this.set({ state: 'pending' }, pool.pending);
        } catch {
            // pool not connected yet - report nothing rather than failing the scrape
        }
    },
});
