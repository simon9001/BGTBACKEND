import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as contractControllers from './contract.controller.js';

// Mounted at /api/contracts (see index.ts)
const contractRoutes = new Hono<AppEnv>();

contractRoutes.use('*', requireAuth);

// List contracts
// filters: procurement_id, fy_id, owner_id, status, expiring_within_days, search, page, limit
contractRoutes.get('/', contractControllers.listContracts);

// One contract with its invoices
contractRoutes.get('/:id', contractControllers.getContract);

// Create a contract for a procurement (procurement owner or Head of ICT)
contractRoutes.post('/', canWrite, contractControllers.createContract);

// Update a contract, e.g. extension of time = new end_date
contractRoutes.put('/:id', canWrite, contractControllers.updateContract);

// Delete a contract with no invoices
contractRoutes.delete('/:id', canWrite, contractControllers.deleteContract);

export default contractRoutes;
