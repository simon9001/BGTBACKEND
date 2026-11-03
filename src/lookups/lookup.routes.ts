import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canEditLists } from '../middleware/bearAuth.js';
import * as lookupControllers from './lookup.controller.js';

// Mounted at /api/lookups (see index.ts)
const lookupRoutes = new Hono<AppEnv>();

lookupRoutes.use('*', requireAuth);

// List dropdown values (any logged-in user - needed to fill forms)
lookupRoutes.get('/', lookupControllers.getLookups);

// Add a value
lookupRoutes.post('/', canEditLists, lookupControllers.createLookup);

// Rename / reorder / deactivate a value
lookupRoutes.put('/:id', canEditLists, lookupControllers.updateLookup);

export default lookupRoutes;
