import { z } from 'zod';
import { isoDate } from './common.validators.js';

/**
 * Validators for the settings managed by the Head of ICT:
 * lookups, financial years and workflow stages.
 */

// ------------------------------- Lookups -------------------------------------

export const LOOKUP_TYPES = ['category', 'priority', 'acquisition_method', 'scm_officer'] as const;
export type LookupType = (typeof LOOKUP_TYPES)[number];

export const LookupQuerySchema = z.object({
    type: z.enum(LOOKUP_TYPES).optional(),
    include_inactive: z.stringbool().default(false),
});

export const CreateLookupSchema = z.object({
    lookup_type: z.enum(LOOKUP_TYPES),
    value: z.string().trim().min(1).max(150),
    sort_order: z.number().int().min(0).default(0),
});

export const UpdateLookupSchema = z.object({
    value: z.string().trim().min(1).max(150).optional(),
    sort_order: z.number().int().min(0).optional(),
    is_active: z.boolean().optional(),
});

// ---------------------------- Financial years --------------------------------

const fyCode = z.string().trim().regex(/^\d{4}\/\d{2}$/, 'Code must look like 2026/27');

export const CreateFinancialYearSchema = z
    .object({
        code: fyCode,
        start_date: isoDate,
        end_date: isoDate,
    })
    .refine((fy) => fy.end_date > fy.start_date, { message: 'end_date must be after start_date', path: ['end_date'] });

export const UpdateFinancialYearSchema = z.object({
    code: fyCode.optional(),
    start_date: isoDate.optional(),
    end_date: isoDate.optional(),
});

// ---------------------------- Workflow stages --------------------------------

export const STAGE_GROUPS = ['Memo', 'eGP', 'ToR', 'Tender', 'ERP', 'Contract', 'Delivery', 'Closed'] as const;

export const StageQuerySchema = z.object({
    include_inactive: z.stringbool().default(false),
});

export const CreateStageSchema = z.object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,30}$/, 'Code may only contain letters, numbers and _'),
    name: z.string().trim().min(2).max(150),
    stage_group: z.enum(STAGE_GROUPS),
    sort_order: z.number().int().min(0),
    sla_days: z.number().int().min(0).max(365).default(5),
});

export const UpdateStageSchema = z.object({
    name: z.string().trim().min(2).max(150).optional(),
    stage_group: z.enum(STAGE_GROUPS).optional(),
    sort_order: z.number().int().min(0).optional(),
    sla_days: z.number().int().min(0).max(365).optional(),
    is_active: z.boolean().optional(),
});

export type CreateLookupInput = z.infer<typeof CreateLookupSchema>;
export type UpdateLookupInput = z.infer<typeof UpdateLookupSchema>;
export type CreateFinancialYearInput = z.infer<typeof CreateFinancialYearSchema>;
export type UpdateFinancialYearInput = z.infer<typeof UpdateFinancialYearSchema>;
export type CreateStageInput = z.infer<typeof CreateStageSchema>;
export type UpdateStageInput = z.infer<typeof UpdateStageSchema>;
