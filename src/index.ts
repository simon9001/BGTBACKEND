import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { contextStorage } from 'hono/context-storage';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { env } from './config/env.js';
import initDatabaseConnection, { closeDatabaseConnection } from './db/dbconfig.js';
import { appLogger, logger } from './logger/logger.js';
import { appErrorsTotal, registerMetrics } from './metrics/metrics.js';
import type { AppEnv } from './types/hono.js';
import { HttpError, fromSqlError } from './utils/http-error.js';
import { apiLimiter } from './middleware/rateLimiter.js';
import { requestLogger } from './middleware/requestLogger.js';

// Feature routes
import authRoutes from './auth/auth.routes.js';
import userRoutes from './users/user.routes.js';
import lookupRoutes from './lookups/lookup.routes.js';
import financialYearRoutes from './financial-years/financialYear.routes.js';
import workflowStageRoutes from './workflow-stages/workflowStage.routes.js';
import budgetLineRoutes from './budget-lines/budgetLine.routes.js';
import procurementRoutes from './procurements/procurement.routes.js';
import contractRoutes from './contracts/contract.routes.js';
import invoiceRoutes from './invoices/invoice.routes.js';
import paymentRoutes from './payments/payment.routes.js';
import taskRoutes from './tasks/task.routes.js';
import dashboardRoutes from './dashboard/dashboard.routes.js';
import auditRoutes from './audit/audit.routes.js';
import metricsRoutes from './metrics/metrics.routes.js';

/**
 * BGTtracker API - ICT Department Budget & Procurement Tracker.
 *
 * Every feature lives in its own folder (routes -> controller -> service) and
 * is mounted under its own /api/<feature> base path below.
 *
 * Observability (see logger/ and metrics/):
 *   - every request gets an id, returned in the X-Request-Id header
 *   - every request is logged (who, what, status, duration) to console + daily files
 *   - Prometheus metrics are exposed at /metrics
 *   - data changes and logins are also stored in AuditLogs / AuthEvents
 */

const app = new Hono<AppEnv>();

// ----------------------------- Global middleware -----------------------------
// Order matters: the request id and context storage must exist before anything logs.
app.use('*', requestId());        // X-Request-Id: reuse the caller's or generate one
app.use('*', contextStorage());   // lets services read the request id / IP (utils/request-context.ts)
app.use('*', requestLogger);      // one "http" log line per request
app.use('*', registerMetrics);    // request count + duration for Prometheus
app.use('*', secureHeaders());    // sensible security headers
app.use('*', cors({
    origin: env.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
    exposeHeaders: ['X-Request-Id'],
}));
app.use('/api/*', apiLimiter);

// ------------------------- Health check & monitoring -------------------------
app.get('/', (c) => c.json({ success: true, service: 'BGTtracker API', status: 'running' }));
app.route('/metrics', metricsRoutes);

// ---------------------------------- Routes -----------------------------------
// Access & settings
app.route('/api/auth', authRoutes);
app.route('/api/users', userRoutes);
app.route('/api/lookups', lookupRoutes);
app.route('/api/financial-years', financialYearRoutes);
app.route('/api/workflow-stages', workflowStageRoutes);

// Planning & tracking
app.route('/api/budget-lines', budgetLineRoutes);
app.route('/api/procurements', procurementRoutes);
app.route('/api/tasks', taskRoutes);

// Money
app.route('/api/contracts', contractRoutes);
app.route('/api/invoices', invoiceRoutes);
app.route('/api/payments', paymentRoutes);

// Reporting
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/audit-logs', auditRoutes);

// ------------------------------ Error handling -------------------------------
app.notFound((c) =>
    c.json({ success: false, error: 'Route not found', path: c.req.path, method: c.req.method }, 404),
);

// Single place that turns thrown errors into JSON responses.
// Expected errors (4xx) are logged by requestLogger; unexpected ones are logged
// here with the full stack. request_id lets staff report the exact failure.
app.onError((error, c) => {
    if (error instanceof HttpError) {
        return c.json({ success: false, error: error.message, details: error.details }, error.status);
    }

    const sqlError = fromSqlError(error);
    if (sqlError) {
        return c.json({ success: false, error: sqlError.message }, sqlError.status);
    }

    const request_id = c.get('requestId');
    appErrorsTotal.inc({ type: 'unhandled' });
    appLogger.error({ err: error, request_id, method: c.req.method, path: c.req.path, user_id: c.get('user')?.user_id }, 'Unhandled error');
    return c.json({ success: false, error: 'Internal server error', request_id }, 500);
});

// ------------------------------- Process events ------------------------------

// Flushes buffered log lines to disk before the process exits
const exitAfterFlush = (code: number) => logger.flush(() => process.exit(code));

process.on('unhandledRejection', (reason) => {
    appErrorsTotal.inc({ type: 'unhandled_rejection' });
    appLogger.error({ err: reason }, 'Unhandled promise rejection');
});

process.on('uncaughtException', (err) => {
    appLogger.fatal({ err }, 'Uncaught exception - shutting down');
    exitAfterFlush(1);
});

// ------------------------------- Start server --------------------------------
// Connect to the database first; only start accepting requests once connected.
initDatabaseConnection()
    .then(() => {
        const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
            appLogger.info({ port: info.port, env: env.NODE_ENV, log_level: env.LOG_LEVEL }, `BGTtracker API running on http://localhost:${info.port}`);
        });

        // Close the HTTP server and DB pool cleanly on Ctrl+C / service stop
        const shutdown = (signal: string) => {
            appLogger.info({ signal }, 'Shutting down');
            server.close(async () => {
                await closeDatabaseConnection();
                exitAfterFlush(0);
            });
        };
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    })
    .catch(() => {
        appLogger.fatal('Server not started because the database is unavailable');
        exitAfterFlush(1);
    });

export default app;
