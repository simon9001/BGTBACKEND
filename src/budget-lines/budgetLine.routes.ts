import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as budgetLineControllers from './budgetLine.controller.js';

// Mounted at /api/budget-lines (see index.ts)
const budgetLineRoutes = new Hono<AppEnv>();

budgetLineRoutes.use('*', requireAuth);

// List budget lines (filters: fy_id, category_id, owner_id, search, page, limit)
budgetLineRoutes.get('/', budgetLineControllers.listBudgetLines);

// One budget line with allocations and linked procurements
budgetLineRoutes.get('/:id', budgetLineControllers.getBudgetLine);

// Create a budget line (optionally with allocations)
budgetLineRoutes.post('/', canWrite, budgetLineControllers.createBudgetLine);

// Update a budget line (owner or Head of ICT)
budgetLineRoutes.put('/:id', canWrite, budgetLineControllers.updateBudgetLine);

// Set / remove the planned spend for one financial year
budgetLineRoutes.put('/:id/allocations/:fyId', canWrite, budgetLineControllers.setAllocation);
budgetLineRoutes.delete('/:id/allocations/:fyId', canWrite, budgetLineControllers.deleteAllocation);

// Delete a budget line (owner or Head of ICT)
budgetLineRoutes.delete('/:id', canWrite, budgetLineControllers.deleteBudgetLine);

export default budgetLineRoutes;
