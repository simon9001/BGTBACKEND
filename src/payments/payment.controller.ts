import type { Context } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam, validateQuery } from '../middleware/validation.js';
import { CreatePaymentSchema, PaymentQuerySchema } from '../validators/invoice.validators.js';
import { getInvoiceRowService } from '../invoices/invoice.service.js';
import { assertCanEdit } from '../utils/access.js';
import { HttpError } from '../utils/http-error.js';
import { buildPagination } from '../utils/pagination.js';
import * as paymentServices from './payment.service.js';

/**
 * Payments controller.
 * Whoever may edit the procurement behind an invoice may record its payments.
 */

// GET /api/payments
export const listPayments = async (c: Context<AppEnv>) => {
    const query = validateQuery(c, PaymentQuerySchema);
    const { total, totalAmount, rows } = await paymentServices.listPaymentsService(query);
    return c.json({
        success: true,
        data: rows,
        summary: { total_amount: totalAmount },
        pagination: buildPagination(query.page, query.limit, total),
    });
};

// POST /api/payments
export const createPayment = async (c: Context<AppEnv>) => {
    const input = await validateBody(c, CreatePaymentSchema);
    const user = c.get('user');

    const invoice = await getInvoiceRowService(input.invoice_id);
    if (!invoice) throw new HttpError(400, 'invoice_id does not match an existing invoice');
    assertCanEdit(user, invoice.owner_id);

    const paymentId = await paymentServices.createPaymentService(input, user.user_id);
    return c.json({ success: true, message: 'Payment recorded', data: { payment_id: paymentId } }, 201);
};

// DELETE /api/payments/:id
export const deletePayment = async (c: Context<AppEnv>) => {
    const paymentId = validateIdParam(c, 'id');
    const user = c.get('user');

    const payment = await paymentServices.getPaymentRowService(paymentId);
    if (!payment) throw new HttpError(404, 'Payment not found');
    assertCanEdit(user, payment.owner_id);

    await paymentServices.deletePaymentService(payment, user.user_id);
    return c.json({ success: true, message: 'Payment deleted' });
};
