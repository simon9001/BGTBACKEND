import { z } from 'zod';
import { PaginationQuerySchema, id, money, optionalText, queryId } from './common.validators.js';
import { sumAmounts, toCents } from '../utils/money.js';

/**
 * Budget line validators.
 * A budget line is what the department plans to buy; allocations spread its
 * cost over one or more financial years (and optionally quarters).
 */

// Planned spend for one financial year. Quarter amounts are optional, but
// together they may not exceed the planned amount for the year.
export const AllocationSchema = z
    .object({
        planned_amount: money,
        q1_amount: money.default(0),
        q2_amount: money.default(0),
        q3_amount: money.default(0),
        q4_amount: money.default(0),
    })
    .refine((a) => toCents(sumAmounts([a.q1_amount, a.q2_amount, a.q3_amount, a.q4_amount])) <= toCents(a.planned_amount), {
        message: 'Quarterly amounts cannot add up to more than the planned amount for the year',
        path: ['planned_amount'],
    });

export const CreateBudgetLineSchema = z
    .object({
        code: optionalText(20),
        description: z.string().trim().min(3).max(500),
        category_id: id,
        priority_id: id.nullish(),
        owner_id: id.optional(),          // admin only; officers always own what they create
        quantity: z.number().int().positive().default(1),
        unit_price: money,
        notes: optionalText(4000),
        allocations: z.array(AllocationSchema.and(z.object({ fy_id: id }))).default([]),
    })
    .refine((line) => new Set(line.allocations.map((a) => a.fy_id)).size === line.allocations.length, {
        message: 'Each financial year can only appear once in allocations',
        path: ['allocations'],
    });

export const UpdateBudgetLineSchema = z.object({
    code: optionalText(20).optional(),
    description: z.string().trim().min(3).max(500).optional(),
    category_id: id.optional(),
    priority_id: id.nullish(),
    owner_id: id.optional(),              // admin only
    quantity: z.number().int().positive().optional(),
    unit_price: money.optional(),
    notes: optionalText(4000).optional(),
});

export const BudgetLineQuerySchema = PaginationQuerySchema.extend({
    fy_id: queryId,              // only lines with an allocation in this year
    category_id: queryId,
    owner_id: queryId,
    search: z.string().trim().max(100).optional(),
});

export type AllocationInput = z.infer<typeof AllocationSchema>;
export type CreateBudgetLineInput = z.infer<typeof CreateBudgetLineSchema>;
export type UpdateBudgetLineInput = z.infer<typeof UpdateBudgetLineSchema>;
export type BudgetLineQuery = z.infer<typeof BudgetLineQuerySchema>;
