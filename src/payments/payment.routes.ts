import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as paymentControllers from './payment.controller.js';

// Mounted at /api/payments (see index.ts)
const paymentRoutes = new Hono<AppEnv>();

paymentRoutes.use('*', requireAuth);

// List payments (filters: invoice_id, contract_id, fy_id, paid_from, paid_to, page, limit)
paymentRoutes.get('/', paymentControllers.listPayments);

// Record a payment against an approved invoice
paymentRoutes.post('/', canWrite, paymentControllers.createPayment);

// Delete a payment entered by mistake
paymentRoutes.delete('/:id', canWrite, paymentControllers.deletePayment);

export default paymentRoutes;
