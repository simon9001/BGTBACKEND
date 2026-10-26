import { z } from 'zod';
import { PaginationQuerySchema, id, isoDate, money, optionalText, queryId } from './common.validators.js';

/**
 * Contract validators.
 */

export const CONTRACT_STATUSES = ['Active', 'Completed', 'Expired', 'Terminated'] as const;

const datesInOrder = (c: { start_date?: string; end_date?: string }) =>
    !c.start_date || !c.end_date || c.end_date >= c.start_date;
const datesMessage = { message: 'end_date cannot be before start_date', path: ['end_date'] };

export const CreateContractSchema = z
    .object({
        procurement_id: id,
        contract_number: z.string().trim().min(1).max(50),
        supplier_name: z.string().trim().min(2).max(200),
        contract_value: money,
        start_date: isoDate,
        end_date: isoDate,
        status: z.enum(CONTRACT_STATUSES).default('Active'),
        notes: optionalText(4000),
    })
    .refine(datesInOrder, datesMessage);

export const UpdateContractSchema = z
    .object({
        contract_number: z.string().trim().min(1).max(50).optional(),
        supplier_name: z.string().trim().min(2).max(200).optional(),
        contract_value: money.optional(),
        start_date: isoDate.optional(),
        end_date: isoDate.optional(),          // extension of time = new end date
        status: z.enum(CONTRACT_STATUSES).optional(),
        notes: optionalText(4000).optional(),
    })
    .refine(datesInOrder, datesMessage);

export const ContractQuerySchema = PaginationQuerySchema.extend({
    procurement_id: queryId,
    fy_id: queryId,
    owner_id: queryId,
    status: z.enum(CONTRACT_STATUSES).optional(),
    expiring_within_days: z.coerce.number().int().positive().max(3650).optional(),
    search: z.string().trim().max(100).optional(),
});

export type CreateContractInput = z.infer<typeof CreateContractSchema>;
export type UpdateContractInput = z.infer<typeof UpdateContractSchema>;
export type ContractQuery = z.infer<typeof ContractQuerySchema>;
