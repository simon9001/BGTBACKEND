import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreateStageSchema, StageQuerySchema, UpdateStageSchema } from '../validators/settings.validators.js';
import { HttpError } from '../utils/http-error.js';
import * as stageServices from './workflowStage.service.js';

// GET /api/workflow-stages?include_inactive=true
export const getStages = async (c: Context<AppEnv>) => {
    const { include_inactive } = validateQuery(c, StageQuerySchema);
    const stages = await stageServices.getStagesService(include_inactive);
    return c.json({ success: true, data: stages });
};

// POST /api/workflow-stages
export const createStage = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateStageSchema);
    const stage = await stageServices.createStageService(input, c.get('user').user_id);
    return c.json({ success: true, message: 'Stage created', data: stage }, 201);
};

// PUT /api/workflow-stages/:id
export const updateStage = async (c: Context<AppEnv>) => {
    const stageId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateStageSchema);
    const stage = await stageServices.updateStageService(stageId, input, c.get('user').user_id);
    if (!stage) throw new HttpError(404, 'Stage not found');
    return c.json({ success: true, message: 'Stage updated', data: stage });
};
