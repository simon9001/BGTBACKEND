import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreateMemoSchema, MemoQuerySchema, UpdateMemoSchema } from '../validators/memo.validators.js';
import { assertLookups } from '../lookups/lookup.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { cached } from '../utils/cache.js';
import { quarterDates } from '../financial-years/financialYear.service.js';
import { buildPagination } from '../utils/pagination.js';
import * as memoServices from './memo.service.js';

/**
 * Memos controller.
 * Officers manage their own memos; the Head of ICT can manage anyone's.
 */

// Loads a memo or throws 404
const findMemoOrFail = async (memoId: number) => {
    const memo = await memoServices.getMemoRowService(memoId);
    if (!memo) throw new HttpError(404, 'Memo not found');
    return memo;
};

// Checks every lookup id in the input points at an active value of the right type
const checkLookups = (input: { category_id?: number; priority_id?: number | null }) =>
    assertLookups([
        { field: 'category_id', id: input.category_id, type: 'category' },
        { field: 'priority_id', id: input.priority_id, type: 'priority' },
    ]);

// GET /api/memos
export const listMemos = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, MemoQuerySchema);
    const dates = await quarterDates(query.fy_id, query.quarter);
    const { total, rows } = await cached(`memos:${JSON.stringify(query)}`, () => memoServices.listMemosService({ ...query, ...dates }));
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// POST /api/memos
export const createMemo = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateMemoSchema);
    const user = c.get('user');

    const ownerId = user.role === 'admin' ? (input.owner_id ?? user.user_id) : user.user_id;
    await checkLookups(input);

    const memo = await memoServices.createMemoService({ ...input, owner_id: ownerId }, user.user_id);
    return c.json({ success: true, message: 'Memo created', data: memo }, 201);
};

// PUT /api/memos/:id
export const updateMemo = async (c: Context<AppEnv>) => {
    const memoId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateMemoSchema);
    const user = c.get('user');

    const memo = await findMemoOrFail(memoId);
    assertCanEdit(user, memo.owner_id);
    if (input.owner_id !== undefined && input.owner_id !== memo.owner_id && user.role !== 'admin') {
        throw new HttpError(403, 'Only the Head of ICT can reassign a memo');
    }
    await checkLookups(input);

    const updated = await memoServices.updateMemoService(memo, input, user.user_id);
    return c.json({ success: true, message: 'Memo updated', data: updated });
};

// DELETE /api/memos/:id
export const deleteMemo = async (c: Context<AppEnv>) => {
    const memoId = validateIdParam(c, 'id');
    const user = c.get('user');

    const memo = await findMemoOrFail(memoId);
    assertCanEdit(user, memo.owner_id);

    await memoServices.deleteMemoService(memo, user.user_id);
    return c.json({ success: true, message: 'Memo deleted' });
};
