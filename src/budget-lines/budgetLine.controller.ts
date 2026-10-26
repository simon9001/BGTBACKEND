import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import {
    AllocationSchema,
    BudgetLineQuerySchema,
    CreateBudgetLineSchema,
    UpdateBudgetLineSchema,
} from '../validators/budgetLine.validators.js';
import { assertLookups } from '../lookups/lookup.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as budgetLineServices from './budgetLine.service.js';

/**
 * Budget lines controller.
 * Everyone can view; officers edit only lines they own; the Head of ICT can
 * edit any line and reassign owners.
 */

// Loads a line or throws 404
const findLineOrFail = async (budgetLineId: number) => {
    const line = await budgetLineServices.getBudgetLineRowService(budgetLineId);
    if (!line) throw new HttpError(404, 'Budget line not found');
    return line;
};

// GET /api/budget-lines
export const listBudgetLines = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, BudgetLineQuerySchema);
    const { total, rows } = await budgetLineServices.listBudgetLinesService(query);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// GET /api/budget-lines/:id
export const getBudgetLine = async (c: Context<AppEnv>) => {
    const budgetLineId = validateIdParam(c, 'id');
    const line = await budgetLineServices.getBudgetLineDetailService(budgetLineId);
    if (!line) throw new HttpError(404, 'Budget line not found');
    return c.json({ success: true, data: line });
};

// POST /api/budget-lines
export const createBudgetLine = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateBudgetLineSchema);
    const user = c.get('user');

    // Officers always own what they create; only the Head of ICT can assign someone else
    const ownerId = user.role === 'admin' ? (input.owner_id ?? user.user_id) : user.user_id;

    await assertLookups([
        { field: 'category_id', id: input.category_id, type: 'category' },
        { field: 'priority_id', id: input.priority_id, type: 'priority' },
    ]);

    const budgetLineId = await budgetLineServices.createBudgetLineService({ ...input, owner_id: ownerId }, user.user_id);
    const line = await budgetLineServices.getBudgetLineDetailService(budgetLineId);
    return c.json({ success: true, message: 'Budget line created', data: line }, 201);
};

// PUT /api/budget-lines/:id
export const updateBudgetLine = async (c: Context<AppEnv>) => {
    const budgetLineId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateBudgetLineSchema);
    const user = c.get('user');

    const line = await findLineOrFail(budgetLineId);
    assertCanEdit(user, line.owner_id);
    if (input.owner_id !== undefined && input.owner_id !== line.owner_id && user.role !== 'admin') {
        throw new HttpError(403, 'Only the Head of ICT can reassign a budget line');
    }

    await assertLookups([
        { field: 'category_id', id: input.category_id, type: 'category' },
        { field: 'priority_id', id: input.priority_id, type: 'priority' },
    ]);

    await budgetLineServices.updateBudgetLineService(line, input, user.user_id);
    const updated = await budgetLineServices.getBudgetLineDetailService(budgetLineId);
    return c.json({ success: true, message: 'Budget line updated', data: updated });
};

// PUT /api/budget-lines/:id/allocations/:fyId
export const setAllocation = async (c: Context<AppEnv>) => {
    const budgetLineId = validateIdParam(c, 'id');
    const fyId = validateIdParam(c, 'fyId');
    const input = await validateBody(c, AllocationSchema);
    const user = c.get('user');

    const line = await findLineOrFail(budgetLineId);
    assertCanEdit(user, line.owner_id);

    await budgetLineServices.setAllocationService(line, fyId, input, user.user_id);
    const updated = await budgetLineServices.getBudgetLineDetailService(budgetLineId);
    return c.json({ success: true, message: 'Allocation saved', data: updated });
};

// DELETE /api/budget-lines/:id/allocations/:fyId
export const deleteAllocation = async (c: Context<AppEnv>) => {
    const budgetLineId = validateIdParam(c, 'id');
    const fyId = validateIdParam(c, 'fyId');
    const user = c.get('user');

    const line = await findLineOrFail(budgetLineId);
    assertCanEdit(user, line.owner_id);

    const deleted = await budgetLineServices.deleteAllocationService(line, fyId, user.user_id);
    if (!deleted) throw new HttpError(404, 'No allocation for that financial year');
    return c.json({ success: true, message: 'Allocation removed' });
};

// DELETE /api/budget-lines/:id
export const deleteBudgetLine = async (c: Context<AppEnv>) => {
    const budgetLineId = validateIdParam(c, 'id');
    const user = c.get('user');

    const line = await findLineOrFail(budgetLineId);
    assertCanEdit(user, line.owner_id);

    await budgetLineServices.deleteBudgetLineService(line, user.user_id);
    return c.json({ success: true, message: 'Budget line deleted' });
};
