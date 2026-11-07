import { z } from 'zod';
import { PaginationQuerySchema, queryQuarter, id, isoDate, optionalText, queryId } from './common.validators.js';

/**
 * Procurement & stage-event validators.
 */

export const PROCUREMENT_STATUSES = ['Not Started', 'In Progress', 'In Review', 'On Hold', 'Completed', 'Cancelled', 'Rejected'] as const;
export const STAGE_EVENT_STATUSES = ['Pending', 'In Progress', 'In Review', 'Approved', 'Completed', 'Rejected', 'Returned'] as const;

// Fields shared by create and update
const procurementFields = {
    reference: optionalText(30),
    title: z.string().trim().min(3).max(500),
    budget_line_id: id.nullish(),
    section_id: id.nullish(),
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

const tenderDatesMessage = { message: 'The opening date cannot be before the float date', path: ['tender_opening_date'] };

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
    quarter: queryQuarter,
    fy_id: queryId,
    status: z.enum(PROCUREMENT_STATUSES).optional(),
    category_id: queryId,
    owner_id: queryId,
    stage_id: queryId,
    budget_line_id: queryId,
    priority_id: queryId,
    no_priority: z.stringbool().optional(),
    acquisition_method_id: queryId,
    no_method: z.stringbool().optional(),
    stage_group: z.string().trim().max(30).optional(),
    no_stage: z.stringbool().optional(),         // has not reached any step yet
    passed_stage_id: queryId,                    // has completed this step
    open_only: z.stringbool().optional(),        // not completed, cancelled or rejected
    statuses: z.string().trim().max(100)         // several statuses, comma separated
        .refine((value) => value.split(',').every((status) => (PROCUREMENT_STATUSES as readonly string[]).includes(status)), 'Unknown status')
        .optional(),
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

// PUT /api/procurements/:id/stages/:eventId - correct a step update
export const CorrectStageEventSchema = RecordStageEventSchema.pick({ status: true, event_date: true });

export type CorrectStageEventInput = z.infer<typeof CorrectStageEventSchema>;
export type CreateProcurementInput = z.infer<typeof CreateProcurementSchema>;
export type UpdateProcurementInput = z.infer<typeof UpdateProcurementSchema>;
export type ProcurementQuery = z.infer<typeof ProcurementQuerySchema>;
export type RecordStageEventInput = z.infer<typeof RecordStageEventSchema>;
