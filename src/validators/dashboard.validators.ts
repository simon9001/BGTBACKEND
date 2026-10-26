import { z } from 'zod';
import { queryId } from './common.validators.js';

/**
 * Dashboard query validators.
 * Every dashboard endpoint accepts the same filters; when fy_id is omitted the
 * current financial year is used.
 */

export const DashboardQuerySchema = z.object({
    fy_id: queryId,
    category_id: queryId,
    owner_id: queryId,
});

export const ExpiringContractsQuerySchema = DashboardQuerySchema.extend({
    days: z.coerce.number().int().positive().max(730).default(90),
});

export type DashboardQuery = z.infer<typeof DashboardQuerySchema>;

/** Filters after the financial year has been resolved. */
export interface DashboardFilters {
    fy_id: number;
    category_id?: number;
    owner_id?: number;
}
