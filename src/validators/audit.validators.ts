import { z } from 'zod';
import { PaginationQuerySchema, isoDate, queryId } from './common.validators.js';

// GET /api/audit-logs query string
export const AuditLogQuerySchema = PaginationQuerySchema.extend({
    entity: z.string().trim().max(50).optional(),
    entity_id: queryId,
    user_id: queryId,
});

// GET /api/audit-logs/auth-events query string (login history)
export const AuthEventQuerySchema = PaginationQuerySchema.extend({
    user_id: queryId,
    event_type: z.enum(['LOGIN_SUCCESS', 'LOGIN_FAILED', 'PASSWORD_CHANGED', 'PASSWORD_RESET']).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
});
