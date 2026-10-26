import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam } from '../middleware/validation.js';
import { CreateFinancialYearSchema, UpdateFinancialYearSchema } from '../validators/settings.validators.js';
import { HttpError } from '../utils/http-error.js';
import * as fyServices from './financialYear.service.js';

// GET /api/financial-years
export const getFinancialYears = async (c: Context<AppEnv>) => {
    const years = await fyServices.getFinancialYearsService();
    return c.json({ success: true, data: years });
};

// GET /api/financial-years/current
export const getCurrentFinancialYear = async (c: Context<AppEnv>) => {
    const fy = await fyServices.getCurrentFinancialYearService();
    if (!fy) throw new HttpError(404, 'No current financial year has been set');
    return c.json({ success: true, data: fy });
};

// POST /api/financial-years
export const createFinancialYear = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateFinancialYearSchema);
    const fy = await fyServices.createFinancialYearService(input, c.get('user').user_id);
    return c.json({ success: true, message: 'Financial year created', data: fy }, 201);
};

// PUT /api/financial-years/:id
export const updateFinancialYear = async (c: Context<AppEnv>) => {
    const fyId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateFinancialYearSchema);
    const fy = await fyServices.updateFinancialYearService(fyId, input, c.get('user').user_id);
    if (!fy) throw new HttpError(404, 'Financial year not found');
    return c.json({ success: true, message: 'Financial year updated', data: fy });
};

// PUT /api/financial-years/:id/set-current
export const setCurrentFinancialYear = async (c: Context<AppEnv>) => {
    const fyId = validateIdParam(c, 'id');
    const fy = await fyServices.setCurrentFinancialYearService(fyId, c.get('user').user_id);
    if (!fy) throw new HttpError(404, 'Financial year not found');
    return c.json({ success: true, message: `${fy.code} is now the current financial year`, data: fy });
};
