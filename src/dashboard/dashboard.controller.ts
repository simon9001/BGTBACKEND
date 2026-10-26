import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateQuery } from '../middleware/validation.js';
import {
    DashboardQuerySchema,
    ExpiringContractsQuerySchema,
    type DashboardFilters,
    type DashboardQuery,
} from '../validators/dashboard.validators.js';
import { getCurrentFinancialYearService, getFinancialYearByIdService } from '../financial-years/financialYear.service.js';
import { HttpError } from '../utils/http-error.js';
import * as dashboardServices from './dashboard.service.js';

/**
 * Dashboard controller - one endpoint per chart / widget.
 * Every response includes the resolved financial year so the frontend can
 * label the charts.
 */

// Uses the requested financial year, or the current one when none is given
const resolveFilters = async (query: DashboardQuery) => {
    const fy = query.fy_id
        ? await getFinancialYearByIdService(query.fy_id)
        : await getCurrentFinancialYearService();

    if (!fy) {
        throw new HttpError(query.fy_id ? 404 : 400,
            query.fy_id ? 'Financial year not found' : 'No current financial year is set. Pass fy_id or set a current year.');
    }

    const filters: DashboardFilters = { fy_id: fy.fy_id, category_id: query.category_id, owner_id: query.owner_id };
    return { filters, fy: { fy_id: fy.fy_id, code: fy.code } };
};

// Builds a handler: validate query -> resolve FY -> run service -> wrap response
const dashboardHandler = (load: (filters: DashboardFilters) => Promise<unknown>) =>
    async (c: Context<AppEnv>) => {
        const { filters, fy } = await resolveFilters(validateQuery(c, DashboardQuerySchema));
        const data = await load(filters);
        return c.json({ success: true, financial_year: fy, data });
    };

// GET /api/dashboard/summary - KPI tiles
export const getSummary = dashboardHandler(dashboardServices.getSummaryService);

// GET /api/dashboard/budget-by-category - budget vs contracted vs paid bars
export const getBudgetByCategory = dashboardHandler(dashboardServices.getBudgetByCategoryService);

// GET /api/dashboard/quarterly-spend - planned vs actual columns + running total line
export const getQuarterlySpend = dashboardHandler(dashboardServices.getQuarterlySpendService);

// GET /api/dashboard/pipeline - open items per workflow step
export const getPipeline = dashboardHandler(dashboardServices.getPipelineService);

// GET /api/dashboard/stage-durations - average days per step vs SLA
export const getStageDurations = dashboardHandler(dashboardServices.getStageDurationsService);

// GET /api/dashboard/officer-workload - stacked bars per officer
export const getOfficerWorkload = dashboardHandler(dashboardServices.getOfficerWorkloadService);

// GET /api/dashboard/invoice-ageing - unpaid invoices by age bucket
export const getInvoiceAgeing = dashboardHandler(dashboardServices.getInvoiceAgeingService);

// GET /api/dashboard/attention - overdue / escalated items table
export const getAttentionList = dashboardHandler(dashboardServices.getAttentionListService);

// GET /api/dashboard/expiring-contracts?days=90 - contract expiry timeline
export const getExpiringContracts = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, ExpiringContractsQuerySchema);
    const { filters, fy } = await resolveFilters(query);
    const data = await dashboardServices.getExpiringContractsService(filters, query.days);
    return c.json({ success: true, financial_year: fy, data });
};

// GET /api/dashboard/year-comparison - all financial years side by side
export const getYearComparison = async (c: Context<AppEnv>) => {
    const { category_id, owner_id } = validateQuery(c, DashboardQuerySchema);
    const data = await dashboardServices.getYearComparisonService({ category_id, owner_id });
    return c.json({ success: true, data });
};
