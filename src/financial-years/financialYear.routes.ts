import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, adminOnly } from '../middleware/bearAuth.js';
import * as fyControllers from './financialYear.controller.js';

// Mounted at /api/financial-years (see index.ts)
const financialYearRoutes = new Hono<AppEnv>();

financialYearRoutes.use('*', requireAuth);

// List all financial years (any logged-in user)
financialYearRoutes.get('/', fyControllers.getFinancialYears);

// The current financial year (dashboard default)
financialYearRoutes.get('/current', fyControllers.getCurrentFinancialYear);

// Create a financial year (Head of ICT)
financialYearRoutes.post('/', adminOnly, fyControllers.createFinancialYear);

// Edit code / dates (Head of ICT)
financialYearRoutes.put('/:id', adminOnly, fyControllers.updateFinancialYear);

// Switch the current financial year (Head of ICT)
financialYearRoutes.put('/:id/set-current', adminOnly, fyControllers.setCurrentFinancialYear);

export default financialYearRoutes;
