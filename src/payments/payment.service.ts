import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { syncInvoicePaidStatus } from '../invoices/invoice.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import type { CreatePaymentInput, PaymentQuery } from '../validators/invoice.validators.js';

/**
 * Payments service.
 *
 * Payments are the department's ACTUAL expenditure: the dashboard's spend per
 * financial year / quarter is calculated from payment_date.
 *
 * Rules:
 *   - only an Approved invoice can be paid
 *   - total payments <= invoice amount
 * Payments are not edited; a wrong payment is deleted and re-entered.
 */

/** Raw payment row plus the owner of its procurement (for access checks). */
export interface PaymentRow {
    payment_id: number;
    invoice_id: number;
    amount: number;
    payment_date: string;
    reference: string | null;
    owner_id: number;
}

// Paginated, filterable list of payments
export const listPaymentsService = async (query: PaymentQuery) => {
    const db = getDbPool();
    const from = `
        FROM dbo.Payments pay
        JOIN dbo.Invoices i     ON i.invoice_id = pay.invoice_id
        JOIN dbo.Contracts c    ON c.contract_id = i.contract_id
        JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id
        JOIN dbo.Users u        ON u.user_id = pay.created_by
        LEFT JOIN dbo.FinancialYears fy ON fy.fy_id = @fy_id
        WHERE pay.is_deleted = 0
          AND (@invoice_id IS NULL OR pay.invoice_id = @invoice_id)
          AND (@contract_id IS NULL OR i.contract_id = @contract_id)
          AND (@fy_id IS NULL OR pay.payment_date BETWEEN fy.start_date AND fy.end_date)
          AND (@paid_from IS NULL OR pay.payment_date >= @paid_from)
          AND (@paid_to IS NULL OR pay.payment_date <= @paid_to)`;

    const result = await db.request()
        .input('invoice_id', sql.Int, query.invoice_id ?? null)
        .input('contract_id', sql.Int, query.contract_id ?? null)
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('paid_from', sql.Date, query.paid_from ?? null)
        .input('paid_to', sql.Date, query.paid_to ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total, ISNULL(SUM(pay.amount), 0) AS total_amount ${from};

            SELECT pay.payment_id, pay.invoice_id, i.invoice_number, c.contract_id, c.contract_number, c.supplier_name,
                   p.procurement_id, p.title AS procurement_title,
                   pay.amount, pay.payment_date, pay.reference, pay.notes,
                   pay.created_by, u.full_name AS created_by_name, pay.created_at
            ${from}
            ORDER BY pay.payment_date DESC, pay.payment_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return {
        total: recordsets[0][0].total as number,
        totalAmount: Number(recordsets[0][0].total_amount),
        rows: recordsets[1],
    };
};

// Raw row (not deleted) with the procurement owner - for access checks
export const getPaymentRowService = async (paymentId: number): Promise<PaymentRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, paymentId)
        .query(`SELECT pay.payment_id, pay.invoice_id, pay.amount, CONVERT(CHAR(10), pay.payment_date, 23) AS payment_date,
                       pay.reference, p.owner_id
                FROM dbo.Payments pay
                JOIN dbo.Invoices i     ON i.invoice_id = pay.invoice_id
                JOIN dbo.Contracts c    ON c.contract_id = i.contract_id
                JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id
                WHERE pay.payment_id = @id AND pay.is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// Record a payment against an approved invoice
export const createPaymentService = async (input: CreatePaymentInput, actorId: number): Promise<number> => {
    return withTransaction(async (tx) => {
        // Lock the invoice row so two payments cannot overpay it concurrently
        const check = await new sql.Request(tx)
            .input('invoice_id', sql.Int, input.invoice_id)
            .input('amount', sql.Decimal(18, 2), input.amount)
            .query(`
                SELECT i.status, i.amount,
                       ISNULL((SELECT SUM(amount) FROM dbo.Payments WHERE invoice_id = i.invoice_id AND is_deleted = 0), 0) AS paid,
                       CASE WHEN ISNULL((SELECT SUM(amount) FROM dbo.Payments WHERE invoice_id = i.invoice_id AND is_deleted = 0), 0)
                                 + @amount > i.amount THEN 0 ELSE 1 END AS ok
                FROM dbo.Invoices i WITH (UPDLOCK, HOLDLOCK)
                WHERE i.invoice_id = @invoice_id AND i.is_deleted = 0`);

        const invoice = check.recordset[0];
        if (!invoice) throw new HttpError(400, 'invoice_id does not match an existing invoice');
        if (invoice.status !== 'Approved') {
            throw new HttpError(400, `Only Approved invoices can be paid (this invoice is ${invoice.status})`);
        }
        if (!invoice.ok) {
            const remaining = Number(invoice.amount) - Number(invoice.paid);
            throw new HttpError(400, `Payment exceeds the invoice balance. Remaining balance: ${remaining.toLocaleString()}`);
        }

        const result = await new sql.Request(tx)
            .input('invoice_id', sql.Int, input.invoice_id)
            .input('amount', sql.Decimal(18, 2), input.amount)
            .input('payment_date', sql.Date, input.payment_date)
            .input('reference', sql.NVarChar(50), input.reference)
            .input('notes', sql.NVarChar(1000), input.notes)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Payments (invoice_id, amount, payment_date, reference, notes, created_by)
                    OUTPUT INSERTED.payment_id
                    VALUES (@invoice_id, @amount, @payment_date, @reference, @notes, @created_by)`);

        const paymentId: number = result.recordset[0].payment_id;
        await syncInvoicePaidStatus(tx, input.invoice_id);
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Payments', entityId: paymentId, newValues: input });
        return paymentId;
    });
};

// Soft-delete a payment entered by mistake (invoice drops back from Paid to Approved)
export const deletePaymentService = async (before: PaymentRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        await new sql.Request(tx)
            .input('id', sql.Int, before.payment_id)
            .query(`UPDATE dbo.Payments SET is_deleted = 1 WHERE payment_id = @id`);

        await syncInvoicePaidStatus(tx, before.invoice_id);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Payments', entityId: before.payment_id, oldValues: before });
    });
};
