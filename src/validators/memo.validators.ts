import { z } from 'zod';
import { PaginationQuerySchema, queryQuarter, id, isoDate, optionalText, queryId } from './common.validators.js';
import { PROCUREMENT_STATUSES } from './procurement.validators.js';

/**
 * Memo validators (the T-001 "Memos to DG" rows of the tracker).
 * The memo status list is the same as the procurement status list.
 */

export const DG_STATUSES = ['Pending', 'Approved', 'Rejected', 'Returned'] as const;

// Approval cannot come before delivery
const datesInOrder = (m: { delivered_date?: string | null; approved_date?: string | null }) =>
    !m.delivered_date || !m.approved_date || m.approved_date >= m.delivered_date;

const datesMessage = { message: 'The approval date cannot be before the delivery date', path: ['approved_date'] };

const memoFields = {
    reference: optionalText(30),
    title: z.string().trim().min(3).max(500),
    fy_id: id,
    owner_id: id.optional(),                 // admin only
    category_id: id,
    priority_id: id.nullish(),
    delivered_date: isoDate.nullish(),
    approved_date: isoDate.nullish(),
    dg_status: z.enum(DG_STATUSES).nullish(),
    status: z.enum(PROCUREMENT_STATUSES),
    notes: optionalText(4000),
};

export const CreateMemoSchema = z
    .object({ ...memoFields, status: memoFields.status.default('Not Started') })
    .refine(datesInOrder, datesMessage);

// Every field optional on update
export const UpdateMemoSchema = z.object(memoFields).partial().refine(datesInOrder, datesMessage);

export const MemoQuerySchema = PaginationQuerySchema.extend({
    quarter: queryQuarter,
    fy_id: queryId,
    status: z.enum(PROCUREMENT_STATUSES).optional(),
    category_id: queryId,
    owner_id: queryId,
    search: z.string().trim().max(100).optional(),
});

export type CreateMemoInput = z.infer<typeof CreateMemoSchema>;
export type UpdateMemoInput = z.infer<typeof UpdateMemoSchema>;
export type MemoQuery = z.infer<typeof MemoQuerySchema>;
