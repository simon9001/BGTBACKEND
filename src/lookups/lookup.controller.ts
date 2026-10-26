import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreateLookupSchema, LookupQuerySchema, UpdateLookupSchema } from '../validators/settings.validators.js';
import { HttpError } from '../utils/http-error.js';
import * as lookupServices from './lookup.service.js';

/**
 * Lookups controller.
 * Values are deactivated rather than deleted, so old records keep their labels.
 */

// GET /api/lookups?type=category&include_inactive=true
export const getLookups = async (c: Context<AppEnv>) => {
    const { type, include_inactive } = validateQuery(c, LookupQuerySchema);
    const lookups = await lookupServices.getLookupsService(type, include_inactive);
    return c.json({ success: true, data: lookups });
};

// POST /api/lookups
export const createLookup = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateLookupSchema);
    const lookup = await lookupServices.createLookupService(input, c.get('user').user_id);
    return c.json({ success: true, message: 'Value added', data: lookup }, 201);
};

// PUT /api/lookups/:id
export const updateLookup = async (c: Context<AppEnv>) => {
    const lookupId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateLookupSchema);
    const lookup = await lookupServices.updateLookupService(lookupId, input, c.get('user').user_id);
    if (!lookup) throw new HttpError(404, 'Lookup value not found');
    return c.json({ success: true, message: 'Value updated', data: lookup });
};
