import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreateInvoiceSchema, InvoiceQuerySchema, UpdateInvoiceSchema } from '../validators/invoice.validators.js';
import { getContractRowService } from '../contracts/contract.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as invoiceServices from './invoice.service.js';

/**
 * Invoices controller.
 * Whoever may edit the procurement behind a contract may manage its invoices.
 */

// Loads an invoice or throws 404
const findInvoiceOrFail = async (invoiceId: number) => {
    const invoice = await invoiceServices.getInvoiceRowService(invoiceId);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    return invoice;
};

// GET /api/invoices
export const listInvoices = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, InvoiceQuerySchema);
    const { total, rows } = await invoiceServices.listInvoicesService(query);
    return c.json({ success: true, data: rows, pagination: buildPagination(query.page, query.limit, total) });
};

// GET /api/invoices/:id
export const getInvoice = async (c: Context<AppEnv>) => {
    const invoiceId = validateIdParam(c, 'id');
    const invoice = await invoiceServices.getInvoiceDetailService(invoiceId);
    if (!invoice) throw new HttpError(404, 'Invoice not found');
    return c.json({ success: true, data: invoice });
};

// POST /api/invoices
export const createInvoice = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreateInvoiceSchema);
    const user = c.get('user');

    const contract = await getContractRowService(input.contract_id);
    if (!contract) throw new HttpError(400, 'contract_id does not match an existing contract');
    assertCanEdit(user, contract.owner_id);

    const invoiceId = await invoiceServices.createInvoiceService(input, user.user_id);
    const invoice = await invoiceServices.getInvoiceDetailService(invoiceId);
    return c.json({ success: true, message: 'Invoice recorded', data: invoice }, 201);
};

// PUT /api/invoices/:id
export const updateInvoice = async (c: Context<AppEnv>) => {
    const invoiceId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateInvoiceSchema);
    const user = c.get('user');

    const invoice = await findInvoiceOrFail(invoiceId);
    assertCanEdit(user, invoice.owner_id);

    await invoiceServices.updateInvoiceService(invoice, input, user.user_id);
    const updated = await invoiceServices.getInvoiceDetailService(invoiceId);
    return c.json({ success: true, message: 'Invoice updated', data: updated });
};

// DELETE /api/invoices/:id
export const deleteInvoice = async (c: Context<AppEnv>) => {
    const invoiceId = validateIdParam(c, 'id');
    const user = c.get('user');

    const invoice = await findInvoiceOrFail(invoiceId);
    assertCanEdit(user, invoice.owner_id);

    await invoiceServices.deleteInvoiceService(invoice, user.user_id);
    return c.json({ success: true, message: 'Invoice deleted' });
};
