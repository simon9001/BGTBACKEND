import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, adminOnly } from '../middleware/bearAuth.js';
import * as lookupControllers from './lookup.controller.js';

// Mounted at /api/lookups (see index.ts)
const lookupRoutes = new Hono<AppEnv>();

lookupRoutes.use('*', requireAuth);

// List dropdown values (any logged-in user - needed to fill forms)
lookupRoutes.get('/', lookupControllers.getLookups);

// Add a value (Head of ICT)
lookupRoutes.post('/', adminOnly, lookupControllers.createLookup);

// Rename / reorder / deactivate a value (Head of ICT)
lookupRoutes.put('/:id', adminOnly, lookupControllers.updateLookup);

export default lookupRoutes;
