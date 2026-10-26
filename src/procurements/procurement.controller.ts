import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import {
    CreateProcurementSchema,
    ProcurementQuerySchema,
    RecordStageEventSchema,
    UpdateProcurementSchema,
    type UpdateProcurementInput,
} from '../validators/procurement.validators.js';
import { assertLookups } from '../lookups/lookup.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as procurementServices from './procurement.service.js';

/**
 * Procurements controller.
 * Everyone can view; officers edit only procurements they own; the Head of
 * ICT can edit any procurement and reassign owners.
 */

// Loads a procurement or throws 404
const findProcurementOrFail = async (procurementId: number) => {
    const procurement = await procurementServices.getProcurementRowService(procurementId);
    if (!procurement) throw new HttpError(404, 'Procurement not found');
    return procurement;
};

// Checks every lookup id in the input points at an active value of the right type
const checkLookups = (input: Partial<UpdateProcurementInput>) =>
    assertLookups([
        { field: 'category_id', id: input.category_id, type: 'category' },
        { field: 'priority_id', id: input.priority_id, type: 'priority' },
        { field: 'acquisition_method_id', id: input.acquisition_method_id, type: 'acquisition_method' },
        { field: 'scm_officer_id', id: input.scm_officer_id, type: 'scm_officer' },
    ]);

// GET /api/procurements
export const listProcurements = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, ProcurementQuerySchema);
    const { total, rows } = await procurementServices.listProcurementsService(query, c.get('user').user_id);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// GET /api/procurements/:id
export const getProcurement = async (c: Context<AppEnv>) => {
    const procurementId = validateIdParam(c, 'id');
    const procurement = await procurementServices.getProcurementDetailService(procurementId);
    if (!procurement) throw new HttpError(404, 'Procurement not found');
    return c.json({ success: true, data: procurement });
};

// POST /api/procurements
export const createProcurement = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateProcurementSchema);
    const user = c.get('user');

    // Officers always own what they create; only the Head of ICT can assign someone else
    const ownerId = user.role === 'admin' ? (input.owner_id ?? user.user_id) : user.user_id;
    await checkLookups(input);

    const procurementId = await procurementServices.createProcurementService({ ...input, owner_id: ownerId }, user.user_id);
    const procurement = await procurementServices.getProcurementDetailService(procurementId);
    return c.json({ success: true, message: 'Procurement created', data: procurement }, 201);
};

// PUT /api/procurements/:id
export const updateProcurement = async (c: Context<AppEnv>) => {
    const procurementId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateProcurementSchema);
    const user = c.get('user');

    const procurement = await findProcurementOrFail(procurementId);
    assertCanEdit(user, procurement.owner_id);
    if (input.owner_id !== undefined && input.owner_id !== procurement.owner_id && user.role !== 'admin') {
        throw new HttpError(403, 'Only the Head of ICT can reassign a procurement');
    }
    await checkLookups(input);

    await procurementServices.updateProcurementService(procurement, input, user.user_id);
    const updated = await procurementServices.getProcurementDetailService(procurementId);
    return c.json({ success: true, message: 'Procurement updated', data: updated });
};

// DELETE /api/procurements/:id
export const deleteProcurement = async (c: Context<AppEnv>) => {
    const procurementId = validateIdParam(c, 'id');
    const user = c.get('user');

    const procurement = await findProcurementOrFail(procurementId);
    assertCanEdit(user, procurement.owner_id);

    await procurementServices.deleteProcurementService(procurement, user.user_id);
    return c.json({ success: true, message: 'Procurement deleted' });
};

// POST /api/procurements/:id/stages - record a step update
export const recordStageEvent = async (c: Context<AppEnv>) => {
    const procurementId = validateIdParam(c, 'id');
    const input = await validateBody(c, RecordStageEventSchema);
    const user = c.get('user');

    const procurement = await findProcurementOrFail(procurementId);
    assertCanEdit(user, procurement.owner_id);

    await procurementServices.recordStageEventService(procurementId, input, user.user_id);
    const updated = await procurementServices.getProcurementDetailService(procurementId);
    return c.json({ success: true, message: 'Step recorded', data: updated }, 201);
};

// DELETE /api/procurements/:id/stages/:eventId - undo a step recorded by mistake
export const deleteStageEvent = async (c: Context<AppEnv>) => {
    const procurementId = validateIdParam(c, 'id');
    const eventId = validateIdParam(c, 'eventId');
    const user = c.get('user');

    const procurement = await findProcurementOrFail(procurementId);
    assertCanEdit(user, procurement.owner_id);

    const deleted = await procurementServices.deleteStageEventService(procurementId, eventId, user.user_id);
    if (!deleted) throw new HttpError(404, 'Step update not found for this procurement');

    const updated = await procurementServices.getProcurementDetailService(procurementId);
    return c.json({ success: true, message: 'Step update removed', data: updated });
};
