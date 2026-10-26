import { z } from 'zod';
import { PaginationQuerySchema, id, isoDate, optionalText, queryId } from './common.validators.js';

/**
 * Task (follow-up) validators.
 */

export const TASK_STATUSES = ['Open', 'In Progress', 'Done', 'Cancelled'] as const;

export const CreateTaskSchema = z.object({
    title: z.string().trim().min(3).max(300),
    description: optionalText(4000),
    owner_id: id.optional(),              // admin only; officers create tasks for themselves
    procurement_id: id.nullish(),
    priority_id: id.nullish(),
    due_date: isoDate.nullish(),
    status: z.enum(TASK_STATUSES).default('Open'),
});

export const UpdateTaskSchema = z.object({
    title: z.string().trim().min(3).max(300).optional(),
    description: optionalText(4000).optional(),
    owner_id: id.optional(),              // admin only
    procurement_id: id.nullish(),
    priority_id: id.nullish(),
    due_date: isoDate.nullish(),
    status: z.enum(TASK_STATUSES).optional(),
});

export const TaskQuerySchema = PaginationQuerySchema.extend({
    owner_id: queryId,
    procurement_id: queryId,
    status: z.enum(TASK_STATUSES).optional(),
    open_only: z.stringbool().optional(),
    overdue: z.stringbool().optional(),
    mine: z.stringbool().optional(),
});

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type TaskQuery = z.infer<typeof TaskQuerySchema>;
