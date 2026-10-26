import { Hono } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { requireAuth, canWrite } from '../middleware/bearAuth.js';
import * as invoiceControllers from './invoice.controller.js';

// Mounted at /api/invoices (see index.ts)
const invoiceRoutes = new Hono<AppEnv>();

invoiceRoutes.use('*', requireAuth);

// List invoices
// filters: contract_id, procurement_id, fy_id, owner_id, status, unpaid_only,
//          received_from, received_to, search, page, limit
invoiceRoutes.get('/', invoiceControllers.listInvoices);

// One invoice with its payments
invoiceRoutes.get('/:id', invoiceControllers.getInvoice);

// Record an invoice against a contract
invoiceRoutes.post('/', canWrite, invoiceControllers.createInvoice);

// Update an invoice (e.g. move it Received -> Verified -> Approved)
invoiceRoutes.put('/:id', canWrite, invoiceControllers.updateInvoice);

// Delete an invoice with no payments
invoiceRoutes.delete('/:id', canWrite, invoiceControllers.deleteInvoice);

export default invoiceRoutes;
