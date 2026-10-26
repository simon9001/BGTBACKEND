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

/** Standard page / limit query parameters. */
export const PaginationQuerySchema = z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(200).default(25),
});
