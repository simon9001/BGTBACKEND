import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as procurementControllers from './procurement.controller.js';

// Mounted at /api/procurements (see index.ts)
const procurementRoutes = new Hono<AppEnv>();

procurementRoutes.use('*', requireAuth);

// List procurements
// filters: fy_id, status, category_id, owner_id, stage_id, budget_line_id,
//          is_escalated, overdue, mine, search, sort, page, limit
procurementRoutes.get('/', procurementControllers.listProcurements);

// One procurement with step history, contracts and open tasks
procurementRoutes.get('/:id', procurementControllers.getProcurement);

// Create a procurement
procurementRoutes.post('/', canWrite, procurementControllers.createProcurement);

// Update a procurement (owner or Head of ICT)
procurementRoutes.put('/:id', canWrite, procurementControllers.updateProcurement);

// Delete a procurement (owner or Head of ICT)
procurementRoutes.delete('/:id', canWrite, procurementControllers.deleteProcurement);

// Record a workflow step update / undo one recorded by mistake
procurementRoutes.post('/:id/stages', canWrite, procurementControllers.recordStageEvent);
procurementRoutes.delete('/:id/stages/:eventId', canWrite, procurementControllers.deleteStageEvent);

export default procurementRoutes;
