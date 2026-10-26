import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import type { CreateInvoiceInput, InvoiceQuery, UpdateInvoiceInput } from '../validators/invoice.validators.js';

/**
 * Invoices service.
 *
 * Rules (checked in SQL with exact DECIMAL arithmetic, under a row lock on the
 * contract so two people cannot over-invoice at the same moment):
 *   - total of non-rejected invoices <= contract value
 *   - an invoice with payments cannot be rejected or reduced below what is paid
 *   - status becomes "Paid" automatically once payments cover the amount
 */

/** Raw invoice row plus the owner of its procurement (for access checks). */
export interface InvoiceRow {
    invoice_id: number;
    contract_id: number;
    invoice_number: string;
    amount: number;
    invoice_date: string;
    received_date: string;
    status: string;
    notes: string | null;
    owner_id: number;
}

const DISPLAY_SELECT = `
    i.invoice_id, i.contract_id, c.contract_number, c.supplier_name,
    c.procurement_id, p.title AS procurement_title, p.fy_id, fy.code AS fy_code,
    p.owner_id, u.full_name AS owner_name,
    i.invoice_number, i.amount, i.invoice_date, i.received_date, i.status, i.notes,
    paid.paid_amount, i.amount - paid.paid_amount AS balance,
    CASE WHEN i.status IN ('Paid', 'Rejected') THEN NULL
         ELSE DATEDIFF(DAY, i.received_date, CAST(SYSDATETIME() AS DATE)) END AS age_days,
    i.created_at, i.updated_at`;

const DISPLAY_JOINS = `
    FROM dbo.Invoices i
    JOIN dbo.Contracts c       ON c.contract_id = i.contract_id
    JOIN dbo.Procurements p    ON p.procurement_id = c.procurement_id
    JOIN dbo.FinancialYears fy ON fy.fy_id = p.fy_id
    JOIN dbo.Users u           ON u.user_id = p.owner_id
    OUTER APPLY (
        SELECT ISNULL(SUM(pay.amount), 0) AS paid_amount
        FROM dbo.Payments pay
        WHERE pay.invoice_id = i.invoice_id AND pay.is_deleted = 0
    ) paid`;

// ------------------------------- Queries -------------------------------------

// Paginated, filterable list of invoices with paid amount, balance and age
export const listInvoicesService = async (query: InvoiceQuery) => {
    const db = getDbPool();
    const where = `
        WHERE i.is_deleted = 0
          AND (@contract_id IS NULL OR i.contract_id = @contract_id)
          AND (@procurement_id IS NULL OR c.procurement_id = @procurement_id)
          AND (@fy_id IS NULL OR p.fy_id = @fy_id)
          AND (@owner_id IS NULL OR p.owner_id = @owner_id)
          AND (@status IS NULL OR i.status = @status)
          AND (@unpaid_only IS NULL OR @unpaid_only = 0 OR i.status NOT IN ('Paid', 'Rejected'))
          AND (@received_from IS NULL OR i.received_date >= @received_from)
          AND (@received_to IS NULL OR i.received_date <= @received_to)
          AND (@search IS NULL OR i.invoice_number LIKE '%' + @search + '%' OR c.supplier_name LIKE '%' + @search + '%')`;

    const result = await db.request()
        .input('contract_id', sql.Int, query.contract_id ?? null)
        .input('procurement_id', sql.Int, query.procurement_id ?? null)
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('owner_id', sql.Int, query.owner_id ?? null)
        .input('status', sql.NVarChar(20), query.status ?? null)
        .input('unpaid_only', sql.Bit, query.unpaid_only ?? null)
        .input('received_from', sql.Date, query.received_from ?? null)
        .input('received_to', sql.Date, query.received_to ?? null)
        .input('search', sql.NVarChar(100), query.search ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total ${DISPLAY_JOINS} ${where};

            SELECT ${DISPLAY_SELECT} ${DISPLAY_JOINS} ${where}
            ORDER BY i.received_date DESC, i.invoice_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// One invoice with its payments
export const getInvoiceDetailService = async (invoiceId: number) => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, invoiceId)
        .query(`
            SELECT ${DISPLAY_SELECT} ${DISPLAY_JOINS}
            WHERE i.invoice_id = @id AND i.is_deleted = 0;

            SELECT pay.payment_id, pay.amount, pay.payment_date, pay.reference, pay.notes,
                   pay.created_by, u.full_name AS created_by_name, pay.created_at
            FROM dbo.Payments pay
            JOIN dbo.Users u ON u.user_id = pay.created_by
            WHERE pay.invoice_id = @id AND pay.is_deleted = 0
            ORDER BY pay.payment_date DESC;
        `);

    const [invoices, payments] = result.recordsets as sql.IRecordSet<any>[];
    if (invoices.length === 0) return null;
    return { ...invoices[0], payments };
};

// Raw row (not deleted) with the procurement owner - for access checks
export const getInvoiceRowService = async (invoiceId: number): Promise<InvoiceRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, invoiceId)
        .query(`SELECT i.invoice_id, i.contract_id, i.invoice_number, i.amount,
                       CONVERT(CHAR(10), i.invoice_date, 23) AS invoice_date,
                       CONVERT(CHAR(10), i.received_date, 23) AS received_date,
                       i.status, i.notes, p.owner_id
                FROM dbo.Invoices i
                JOIN dbo.Contracts c ON c.contract_id = i.contract_id
                JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id
                WHERE i.invoice_id = @id AND i.is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// ------------------------------- Helpers -------------------------------------

/**
 * Throws 400 if adding `amount` to the contract's other non-rejected invoices
 * would exceed the contract value. Locks the contract row for the transaction.
 */
const assertWithinContractValue = async (tx: sql.Transaction, contractId: number, amount: number, excludeInvoiceId: number | null) => {
    const result = await new sql.Request(tx)
        .input('contract_id', sql.Int, contractId)
        .input('amount', sql.Decimal(18, 2), amount)
        .input('exclude_id', sql.Int, excludeInvoiceId)
        .query(`
            SELECT c.contract_value,
                   ISNULL((SELECT SUM(i.amount) FROM dbo.Invoices i
                           WHERE i.contract_id = c.contract_id AND i.is_deleted = 0 AND i.status <> 'Rejected'
                             AND (@exclude_id IS NULL OR i.invoice_id <> @exclude_id)), 0) AS other_invoices,
                   CASE WHEN ISNULL((SELECT SUM(i.amount) FROM dbo.Invoices i
                           WHERE i.contract_id = c.contract_id AND i.is_deleted = 0 AND i.status <> 'Rejected'
                             AND (@exclude_id IS NULL OR i.invoice_id <> @exclude_id)), 0) + @amount > c.contract_value
                        THEN 0 ELSE 1 END AS ok
            FROM dbo.Contracts c WITH (UPDLOCK, HOLDLOCK)
            WHERE c.contract_id = @contract_id AND c.is_deleted = 0`);

    const row = result.recordset[0];
    if (!row) throw new HttpError(400, 'contract_id does not match an existing contract');
    if (!row.ok) {
        const remaining = Number(row.contract_value) - Number(row.other_invoices);
        throw new HttpError(400, `Invoice total would exceed the contract value. Remaining to invoice: ${remaining.toLocaleString()}`);
    }
};

/**
 * Sets status to "Paid" when payments cover the amount, and back to
 * "Approved" if a fully-paid invoice is no longer covered.
 * Exported for the payments service.
 */
export const syncInvoicePaidStatus = async (tx: sql.Transaction, invoiceId: number): Promise<void> => {
    await new sql.Request(tx)
        .input('id', sql.Int, invoiceId)
        .query(`
            UPDATE i
            SET status = CASE
                            WHEN paid.total >= i.amount THEN 'Paid'
                            WHEN i.status = 'Paid' THEN 'Approved'
                            ELSE i.status
                         END,
                updated_at = SYSUTCDATETIME()
            FROM dbo.Invoices i
            CROSS APPLY (SELECT ISNULL(SUM(amount), 0) AS total FROM dbo.Payments
                         WHERE invoice_id = i.invoice_id AND is_deleted = 0) paid
            WHERE i.invoice_id = @id`);
};

// Total paid against an invoice
const getPaidAmount = async (tx: sql.Transaction, invoiceId: number): Promise<number> => {
    const result = await new sql.Request(tx)
        .input('id', sql.Int, invoiceId)
        .query(`SELECT ISNULL(SUM(amount), 0) AS total FROM dbo.Payments WHERE invoice_id = @id AND is_deleted = 0`);
    return Number(result.recordset[0].total);
};

// ------------------------------- Commands ------------------------------------

// Record a new invoice against a contract
export const createInvoiceService = async (input: CreateInvoiceInput, actorId: number): Promise<number> => {
    return withTransaction(async (tx) => {
        if (input.status !== 'Rejected') {
            await assertWithinContractValue(tx, input.contract_id, input.amount, null);
        }

        const result = await new sql.Request(tx)
            .input('contract_id', sql.Int, input.contract_id)
            .input('invoice_number', sql.NVarChar(50), input.invoice_number)
            .input('amount', sql.Decimal(18, 2), input.amount)
            .input('invoice_date', sql.Date, input.invoice_date)
            .input('received_date', sql.Date, input.received_date)
            .input('status', sql.NVarChar(20), input.status)
            .input('notes', sql.NVarChar(1000), input.notes)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Invoices (contract_id, invoice_number, amount, invoice_date, received_date, status, notes, created_by)
                    OUTPUT INSERTED.invoice_id
                    VALUES (@contract_id, @invoice_number, @amount, @invoice_date, @received_date, @status, @notes, @created_by)`);

        const invoiceId: number = result.recordset[0].invoice_id;
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Invoices', entityId: invoiceId, newValues: input });
        return invoiceId;
    });
};

// Update an invoice. Only fields present in `input` change.
export const updateInvoiceService = async (before: InvoiceRow, input: UpdateInvoiceInput, actorId: number): Promise<void> => {
    const amount = input.amount ?? Number(before.amount);
    // A paid invoice keeps "Paid" unless the user explicitly sets another status
    const status = input.status ?? before.status;

    await withTransaction(async (tx) => {
        const paid = await getPaidAmount(tx, before.invoice_id);
        if (paid > 0 && status === 'Rejected') {
            throw new HttpError(400, 'An invoice with payments cannot be rejected. Remove the payments first.');
        }
        if (amount < paid) {
            throw new HttpError(400, `Amount cannot be less than what has already been paid (${paid.toLocaleString()})`);
        }
        if (status !== 'Rejected') {
            await assertWithinContractValue(tx, before.contract_id, amount, before.invoice_id);
        }

        await new sql.Request(tx)
            .input('id', sql.Int, before.invoice_id)
            .input('invoice_number', sql.NVarChar(50), input.invoice_number ?? before.invoice_number)
            .input('amount', sql.Decimal(18, 2), amount)
            .input('invoice_date', sql.Date, input.invoice_date ?? before.invoice_date)
            .input('received_date', sql.Date, input.received_date ?? before.received_date)
            .input('status', sql.NVarChar(20), status)
            .input('notes', sql.NVarChar(1000), input.notes === undefined ? before.notes : input.notes)
            .query(`UPDATE dbo.Invoices
                    SET invoice_number = @invoice_number, amount = @amount, invoice_date = @invoice_date,
                        received_date = @received_date, status = @status, notes = @notes, updated_at = SYSUTCDATETIME()
                    WHERE invoice_id = @id`);

        // Amount changes can make an invoice fully paid, or no longer fully paid
        await syncInvoicePaidStatus(tx, before.invoice_id);
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Invoices', entityId: before.invoice_id, oldValues: before, newValues: input });
    });
};

// Soft-delete an invoice (refused while it has payments)
export const deleteInvoiceService = async (before: InvoiceRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        if ((await getPaidAmount(tx, before.invoice_id)) > 0) {
            throw new HttpError(409, 'This invoice has payments. Delete the payments first.');
        }

        await new sql.Request(tx)
            .input('id', sql.Int, before.invoice_id)
            .query(`UPDATE dbo.Invoices SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE invoice_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Invoices', entityId: before.invoice_id, oldValues: before });
    });
};
