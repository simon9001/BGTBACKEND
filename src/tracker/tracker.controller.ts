import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateQuery } from '../middleware/validation.js';
import { TrackerQuerySchema } from '../validators/dashboard.validators.js';
import { getCurrentFinancialYearService, getFinancialYearByIdService } from '../financial-years/financialYear.service.js';
import { HttpError } from '../utils/http-error.js';
import { cached } from '../utils/cache.js';
import { getTrackerService } from './tracker.service.js';

// GET /api/tracker?fy_id= - the workbook's sheets as data (default: current year)
export const getTracker = async (c: Context<AppEnv>) => {
    const { fy_id } = validateQuery(c, TrackerQuerySchema);
    const fy = fy_id ? await getFinancialYearByIdService(fy_id) : await getCurrentFinancialYearService();
    if (!fy) throw new HttpError(fy_id ? 404 : 400, fy_id ? 'Financial year not found' : 'No current financial year is set');

    const data = await cached(`tracker:${fy.fy_id}`, () => getTrackerService(fy.fy_id));
    return c.json({ success: true, financial_year: { fy_id: fy.fy_id, code: fy.code }, data });
};
