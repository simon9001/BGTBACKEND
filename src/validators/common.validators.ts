import { z } from 'zod';

/**
 * Small reusable zod building blocks shared by the feature validators.
 */

/** Positive integer id (body field). */
export const id = z.number().int().positive();

/** Optional positive integer id read from the query string. */
export const queryId = z.coerce.number().int().positive().optional();

/** Calendar date in ISO format, e.g. "2026-09-07". */
export const isoDate = z.iso.date('Date must be in YYYY-MM-DD format');

/** Money amount: non-negative, at most 2 decimal places. */
export const money = z
    .number()
    .nonnegative('Amount cannot be negative')
    .multipleOf(0.01, 'Amount can have at most 2 decimal places');

/** Optional free text: trimmed, empty string becomes null. */
export const optionalText = (max: number) =>
    z.string().trim().max(max).nullish().transform((value) => (value ? value : null));

/** Kenyan financial year quarter (1 = Jul-Sep ... 4 = Apr-Jun) read from the query string. */
export const queryQuarter = z.coerce.number().int().min(1).max(4).optional();

/** First and last day of the chosen quarter, worked out by the controller. */
export interface QuarterRange {
    quarter_from?: string;
    quarter_to?: string;
}

/** Standard page / limit query parameters. */
export const PaginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(25),
});
