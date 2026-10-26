import { z } from 'zod';
import { PaginationQuerySchema, id, isoDate, optionalText, queryId } from './common.validators.js';

/**
 * Procurement & stage-event validators.
 */

export const PROCUREMENT_STATUSES = ['Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled', 'Rejected'] as const;
export const STAGE_EVENT_STATUSES = ['Pending', 'In Progress', 'Approved', 'Completed', 'Rejected', 'Returned'] as const;

// Fields shared by create and update
const procurementFields = {
    reference: optionalText(30),
    title: z.string().trim().min(3).max(500),
    budget_line_id: id.nullish(),
    fy_id: id,
    owner_id: id.optional(),                 // admin only
    category_id: id,
    priority_id: id.nullish(),
    acquisition_method_id: id.nullish(),
    scm_officer_id: id.nullish(),
    status: z.enum(PROCUREMENT_STATUSES),
    tender_float_date: isoDate.nullish(),
    tender_opening_date: isoDate.nullish(),
    is_escalated: z.boolean(),
    escalated_to: optionalText(150),
    escalation_note: optionalText(1000),
    notes: optionalText(4000),
};

// Tender opening cannot be before the float date
const tenderDatesInOrder = (p: { tender_float_date?: string | null; tender_opening_date?: string | null }) =>
    !p.tender_float_date || !p.tender_opening_date || p.tender_opening_date >= p.tender_float_date;

const tenderDatesMessage = { message: 'tender_opening_date cannot be before tender_float_date', path: ['tender_opening_date'] };

export const CreateProcurementSchema = z
    .object({
        ...procurementFields,
        status: procurementFields.status.default('Not Started'),
        is_escalated: procurementFields.is_escalated.default(false),
    })
    .refine(tenderDatesInOrder, tenderDatesMessage);

// Every field optional on update
export const UpdateProcurementSchema = z
    .object(procurementFields)
    .partial()
    .refine(tenderDatesInOrder, tenderDatesMessage);

export const ProcurementQuerySchema = PaginationQuerySchema.extend({
    fy_id: queryId,
    status: z.enum(PROCUREMENT_STATUSES).optional(),
    category_id: queryId,
    owner_id: queryId,
    stage_id: queryId,
    budget_line_id: queryId,
    is_escalated: z.stringbool().optional(),
    overdue: z.stringbool().optional(),
    mine: z.stringbool().optional(),            // only items owned by the logged-in user
    search: z.string().trim().max(100).optional(),
    sort: z.enum(['newest', 'priority', 'days_in_stage', 'title']).default('newest'),
});

// POST /api/procurements/:id/stages - record a step update
export const RecordStageEventSchema = z.object({
    stage_id: id,
    status: z.enum(STAGE_EVENT_STATUSES),
    event_date: isoDate,
    notes: optionalText(1000),
});

export type CreateProcurementInput = z.infer<typeof CreateProcurementSchema>;
export type UpdateProcurementInput = z.infer<typeof UpdateProcurementSchema>;
export type ProcurementQuery = z.infer<typeof ProcurementQuerySchema>;
export type RecordStageEventInput = z.infer<typeof RecordStageEventSchema>;
