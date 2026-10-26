import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, adminOnly } from '../middleware/bearAuth.js';
import * as stageControllers from './workflowStage.controller.js';

// Mounted at /api/workflow-stages (see index.ts)
const workflowStageRoutes = new Hono<AppEnv>();

workflowStageRoutes.use('*', requireAuth);

// List procurement steps in order (any logged-in user)
workflowStageRoutes.get('/', stageControllers.getStages);

// Add a step (Head of ICT)
workflowStageRoutes.post('/', adminOnly, stageControllers.createStage);

// Edit a step, its order or its SLA target (Head of ICT)
workflowStageRoutes.put('/:id', adminOnly, stageControllers.updateStage);

export default workflowStageRoutes;
