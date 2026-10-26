import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, adminOnly } from '../middleware/bearAuth.js';
import * as auditControllers from './audit.controller.js';

// Mounted at /api/audit-logs (see index.ts)
const auditRoutes = new Hono<AppEnv>();

// Only the Head of ICT can read the audit trail
auditRoutes.use('*', requireAuth, adminOnly);

// Data changes (filters: entity, entity_id, user_id, page, limit)
auditRoutes.get('/', auditControllers.listAuditLogs);

// Login history (filters: user_id, event_type, from, to, page, limit)
auditRoutes.get('/auth-events', auditControllers.listAuthEvents);

export default auditRoutes;
