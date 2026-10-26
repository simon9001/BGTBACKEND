import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreateTaskSchema, TaskQuerySchema, UpdateTaskSchema } from '../validators/task.validators.js';
import { assertLookups } from '../lookups/lookup.service.js';
import { getProcurementRowService } from '../procurements/procurement.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as taskServices from './task.service.js';

/**
 * Tasks controller.
 * Officers manage their own tasks; the Head of ICT can assign tasks to anyone.
 */

// Loads a task or throws 404
const findTaskOrFail = async (taskId: number) => {
    const task = await taskServices.getTaskRowService(taskId);
    if (!task) throw new HttpError(404, 'Task not found');
    return task;
};

// Validates optional references in a task body
const checkReferences = async (input: { procurement_id?: number | null; priority_id?: number | null }) => {
    await assertLookups([{ field: 'priority_id', id: input.priority_id, type: 'priority' }]);
    if (input.procurement_id != null && !(await getProcurementRowService(input.procurement_id))) {
        throw new HttpError(400, 'procurement_id does not match an existing procurement');
    }
};

// GET /api/tasks
export const listTasks = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, TaskQuerySchema);
    const { total, rows } = await taskServices.listTasksService(query, c.get('user').user_id);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// POST /api/tasks
export const createTask = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateTaskSchema);
    const user = c.get('user');

    const ownerId = user.role === 'admin' ? (input.owner_id ?? user.user_id) : user.user_id;
    await checkReferences(input);

    const task = await taskServices.createTaskService({ ...input, owner_id: ownerId }, user.user_id);
    return c.json({ success: true, message: 'Task created', data: task }, 201);
};

// PUT /api/tasks/:id
export const updateTask = async (c: Context<AppEnv>) => {
    const taskId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateTaskSchema);
    const user = c.get('user');

    const task = await findTaskOrFail(taskId);
    assertCanEdit(user, task.owner_id);
    if (input.owner_id !== undefined && input.owner_id !== task.owner_id && user.role !== 'admin') {
        throw new HttpError(403, 'Only the Head of ICT can reassign a task');
    }
    await checkReferences(input);

    const updated = await taskServices.updateTaskService(task, input, user.user_id);
    return c.json({ success: true, message: 'Task updated', data: updated });
};

// DELETE /api/tasks/:id
export const deleteTask = async (c: Context<AppEnv>) => {
    const taskId = validateIdParam(c, 'id');
    const user = c.get('user');

    const task = await findTaskOrFail(taskId);
    assertCanEdit(user, task.owner_id);

    await taskServices.deleteTaskService(task, user.user_id);
    return c.json({ success: true, message: 'Task deleted' });
};
