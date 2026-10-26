import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateQuery } from '../middleware/validation.js';
import { AuditLogQuerySchema, AuthEventQuerySchema } from '../validators/audit.validators.js';
import { buildPagination } from '../utils/pagination.js';
import * as auditServices from './audit.service.js';

// GET /api/audit-logs - paginated data-change trail (admin only)
export const listAuditLogs = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, AuditLogQuerySchema);
    const { total, rows } = await auditServices.listAuditLogsService(query);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// GET /api/audit-logs/auth-events - login history (admin only)
export const listAuthEvents = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, AuthEventQuerySchema);
    const { total, rows } = await auditServices.listAuthEventsService(query);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};
