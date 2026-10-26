import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth } from '../middleware/bearAuth.js';
import * as dashboardControllers from './dashboard.controller.js';

// Mounted at /api/dashboard (see index.ts)
const dashboardRoutes = new Hono<AppEnv>();

// The dashboard is visible to every logged-in member of the department
dashboardRoutes.use('*', requireAuth);

// Common filters on every endpoint: fy_id (default: current year), category_id, owner_id
dashboardRoutes.get('/summary', dashboardControllers.getSummary);
dashboardRoutes.get('/budget-by-category', dashboardControllers.getBudgetByCategory);
dashboardRoutes.get('/quarterly-spend', dashboardControllers.getQuarterlySpend);
dashboardRoutes.get('/pipeline', dashboardControllers.getPipeline);
dashboardRoutes.get('/stage-durations', dashboardControllers.getStageDurations);
dashboardRoutes.get('/officer-workload', dashboardControllers.getOfficerWorkload);
dashboardRoutes.get('/invoice-ageing', dashboardControllers.getInvoiceAgeing);
dashboardRoutes.get('/expiring-contracts', dashboardControllers.getExpiringContracts);
dashboardRoutes.get('/attention', dashboardControllers.getAttentionList);
dashboardRoutes.get('/year-comparison', dashboardControllers.getYearComparison);

export default dashboardRoutes;
