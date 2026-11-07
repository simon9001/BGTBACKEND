import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateQuery } from '../middleware/validation.js';
import {
    DashboardQuerySchema,
    ExpiringContractsQuerySchema,
    type DashboardFilters,
    type DashboardQuery,
} from '../validators/dashboard.validators.js';
import { getCurrentFinancialYearService, getFinancialYearByIdService, quarterDates } from '../financial-years/financialYear.service.js';
import { HttpError } from '../utils/http-error.js';
import { cached } from '../utils/cache.js';
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

    const filters: DashboardFilters = {
        fy_id: fy.fy_id, category_id: query.category_id, owner_id: query.owner_id,
        quarter: query.quarter, ...(await quarterDates(fy.fy_id, query.quarter)),
    };
    return { filters, fy: { fy_id: fy.fy_id, code: fy.code } };
};

// One cached result per widget and filter combination
const cachedWidget = <T>(name: string, filters: unknown, load: () => Promise<T>, pinned = false) =>
    cached(`dashboard:${name}:${JSON.stringify(filters)}`, load, { pinned });

// Builds a handler: validate query -> resolve FY -> run service -> wrap response
const dashboardHandler = (name: string, load: (filters: DashboardFilters) => Promise<unknown>) => {
    WIDGETS.push({ name, load });
    return async (c: Context<AppEnv>) => {
        const { filters, fy } = await resolveFilters(validateQuery(c, DashboardQuerySchema));
        const data = await cachedWidget(name, filters, () => load(filters));
        return c.json({ success: true, financial_year: fy, data });
    };
};

// Every widget that takes the standard filters, for pre-loading at start-up
const WIDGETS: { name: string; load: (filters: DashboardFilters) => Promise<unknown> }[] = [];

/** Loads the default dashboard (current year, no filters) and keeps it warm. One query at a time. */
export const warmDashboardCache = async () => {
    const fy = await getCurrentFinancialYearService();
    if (!fy) return;

    // Same shape as resolveFilters builds, so the requests find these entries
    const filters: DashboardFilters = { fy_id: fy.fy_id, category_id: undefined, owner_id: undefined };
    for (const { name, load } of WIDGETS) {
        await cachedWidget(name, filters, () => load(filters), true);
    }
    await cachedWidget(`expiring-contracts:${EXPIRING_DEFAULT_DAYS}`, filters, () => dashboardServices.getExpiringContractsService(filters, EXPIRING_DEFAULT_DAYS), true);
    await cachedWidget('year-comparison', { category_id: undefined, owner_id: undefined }, () => dashboardServices.getYearComparisonService({}), true);
};

const EXPIRING_DEFAULT_DAYS = 90;

// GET /api/dashboard/summary - KPI tiles
export const getSummary = dashboardHandler('summary', dashboardServices.getSummaryService);

// GET /api/dashboard/budget-by-category - budget vs contracted vs paid bars
export const getBudgetByCategory = dashboardHandler('budget-by-category', dashboardServices.getBudgetByCategoryService);

// GET /api/dashboard/quarterly-spend - planned vs actual columns + running total line
export const getQuarterlySpend = dashboardHandler('quarterly-spend', dashboardServices.getQuarterlySpendService);

// GET /api/dashboard/pipeline - open items per workflow step
export const getPipeline = dashboardHandler('pipeline', dashboardServices.getPipelineService);

// GET /api/dashboard/stage-durations - average days per step vs SLA
export const getStageDurations = dashboardHandler('stage-durations', dashboardServices.getStageDurationsService);

// GET /api/dashboard/officer-workload - stacked bars per officer
export const getOfficerWorkload = dashboardHandler('officer-workload', dashboardServices.getOfficerWorkloadService);

// GET /api/dashboard/invoice-ageing - unpaid invoices by age bucket
export const getInvoiceAgeing = dashboardHandler('invoice-ageing', dashboardServices.getInvoiceAgeingService);

// GET /api/dashboard/breakdowns - every status, priority and method with its count
export const getBreakdowns = dashboardHandler('breakdowns', dashboardServices.getBreakdownsService);

// GET /api/dashboard/activity-summary - the tracker's own Dashboard sheet figures
export const getActivitySummary = dashboardHandler('activity-summary', dashboardServices.getActivitySummaryService);
export const getBalanceChecks = dashboardHandler('balance-checks', dashboardServices.getBalanceChecksService);

// GET /api/dashboard/monthly-trend - invoices and payments per month of the year
export const getMonthlyTrend = dashboardHandler('monthly-trend', dashboardServices.getMonthlyTrendService);

// GET /api/dashboard/top-budget-lines - largest budget lines of the year
export const getTopBudgetLines = dashboardHandler('top-budget-lines', dashboardServices.getTopBudgetLinesService);

// GET /api/dashboard/recent-activity - latest step updates and payments
export const getRecentActivity = dashboardHandler('recent-activity', dashboardServices.getRecentActivityService);

// GET /api/dashboard/attention - overdue / escalated items table
export const getAttentionList = dashboardHandler('attention', dashboardServices.getAttentionListService);

// GET /api/dashboard/expiring-contracts?days=90 - contract expiry timeline
export const getExpiringContracts = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, ExpiringContractsQuerySchema);
    const { filters, fy } = await resolveFilters(query);
    const data = await cachedWidget(`expiring-contracts:${query.days}`, filters, () => dashboardServices.getExpiringContractsService(filters, query.days));
    return c.json({ success: true, financial_year: fy, data });
};

// GET /api/dashboard/year-comparison - all financial years side by side
export const getYearComparison = async (c: Context<AppEnv>) => {
    const { category_id, owner_id } = validateQuery(c, DashboardQuerySchema);
    const data = await cachedWidget('year-comparison', { category_id, owner_id }, () => dashboardServices.getYearComparisonService({ category_id, owner_id }));
    return c.json({ success: true, data });
};
