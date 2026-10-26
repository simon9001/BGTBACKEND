import { z } from 'zod';
import { PaginationQuerySchema, id, isoDate, money, optionalText, queryId } from './common.validators.js';

/**
 * Invoice & payment validators.
 *
 * Invoice lifecycle: Received -> Verified -> Approved -> Paid (or Rejected).
 * "Paid" is never set by hand - it is set automatically when payments cover
 * the full invoice amount.
 */

export const INVOICE_STATUSES = ['Received', 'Verified', 'Approved', 'Paid', 'Rejected'] as const;
const MANUAL_INVOICE_STATUSES = ['Received', 'Verified', 'Approved', 'Rejected'] as const;

const positiveMoney = money.refine((value) => value > 0, 'Amount must be greater than zero');

// ------------------------------- Invoices ------------------------------------

export const CreateInvoiceSchema = z.object({
    contract_id: id,
    invoice_number: z.string().trim().min(1).max(50),
    amount: positiveMoney,
    invoice_date: isoDate,
    received_date: isoDate,
    status: z.enum(MANUAL_INVOICE_STATUSES).default('Received'),
    notes: optionalText(1000),
});

export const UpdateInvoiceSchema = z.object({
    invoice_number: z.string().trim().min(1).max(50).optional(),
    amount: positiveMoney.optional(),
    invoice_date: isoDate.optional(),
    received_date: isoDate.optional(),
    status: z.enum(MANUAL_INVOICE_STATUSES).optional(),
    notes: optionalText(1000).optional(),
});

export const InvoiceQuerySchema = PaginationQuerySchema.extend({
    contract_id: queryId,
    procurement_id: queryId,
    fy_id: queryId,
    owner_id: queryId,
    status: z.enum(INVOICE_STATUSES).optional(),
    unpaid_only: z.stringbool().optional(),
    received_from: isoDate.optional(),
    received_to: isoDate.optional(),
    search: z.string().trim().max(100).optional(),
});

// ------------------------------- Payments ------------------------------------

export const CreatePaymentSchema = z.object({
    invoice_id: id,
    amount: positiveMoney,
    payment_date: isoDate,
    reference: optionalText(50),
    notes: optionalText(1000),
});

export const PaymentQuerySchema = PaginationQuerySchema.extend({
    invoice_id: queryId,
    contract_id: queryId,
    fy_id: queryId,             // payments made within this financial year
    paid_from: isoDate.optional(),
    paid_to: isoDate.optional(),
});

export type CreateInvoiceInput = z.infer<typeof CreateInvoiceSchema>;
export type UpdateInvoiceInput = z.infer<typeof UpdateInvoiceSchema>;
export type InvoiceQuery = z.infer<typeof InvoiceQuerySchema>;
export type CreatePaymentInput = z.infer<typeof CreatePaymentSchema>;
export type PaymentQuery = z.infer<typeof PaymentQuerySchema>;
