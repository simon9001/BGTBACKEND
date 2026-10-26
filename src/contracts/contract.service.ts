import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import type { ContractQuery, CreateContractInput, UpdateContractInput } from '../validators/contract.validators.js';

/**
 * Contracts service.
 *
 * Rule: a contract's value may not drop below what has already been invoiced
 * against it (rejected invoices do not count).
 */

/** Raw contract row plus the owner of its procurement (for access checks). */
export interface ContractRow {
    contract_id: number;
    procurement_id: number;
    contract_number: string;
    supplier_name: string;
    contract_value: number;
    start_date: string;
    end_date: string;
    status: string;
    notes: string | null;
    owner_id: number;
}

// Invoiced / paid totals per contract, reused by list and detail queries
const TOTALS_APPLY = `
    OUTER APPLY (
        SELECT ISNULL(SUM(i.amount), 0) AS invoiced_amount
        FROM dbo.Invoices i
        WHERE i.contract_id = c.contract_id AND i.is_deleted = 0 AND i.status <> 'Rejected'
    ) inv
    OUTER APPLY (
        SELECT ISNULL(SUM(pay.amount), 0) AS paid_amount
        FROM dbo.Payments pay
        JOIN dbo.Invoices i ON i.invoice_id = pay.invoice_id
        WHERE i.contract_id = c.contract_id AND pay.is_deleted = 0 AND i.is_deleted = 0
    ) paid`;

const DISPLAY_SELECT = `
    c.contract_id, c.procurement_id, p.title AS procurement_title, p.fy_id, fy.code AS fy_code,
    p.owner_id, u.full_name AS owner_name,
    c.contract_number, c.supplier_name, c.contract_value, c.start_date, c.end_date, c.status, c.notes,
    inv.invoiced_amount, paid.paid_amount,
    c.contract_value - paid.paid_amount AS balance,
    DATEDIFF(DAY, CAST(SYSDATETIME() AS DATE), c.end_date) AS days_to_expiry,
    c.created_at, c.updated_at`;

const DISPLAY_JOINS = `
    FROM dbo.Contracts c
    JOIN dbo.Procurements p    ON p.procurement_id = c.procurement_id
    JOIN dbo.FinancialYears fy ON fy.fy_id = p.fy_id
    JOIN dbo.Users u           ON u.user_id = p.owner_id
    ${TOTALS_APPLY}`;

// ------------------------------- Queries -------------------------------------

// Paginated, filterable list of contracts with invoiced / paid totals
export const listContractsService = async (query: ContractQuery) => {
    const db = getDbPool();
    const where = `
        WHERE c.is_deleted = 0
          AND (@procurement_id IS NULL OR c.procurement_id = @procurement_id)
          AND (@fy_id IS NULL OR p.fy_id = @fy_id)
          AND (@owner_id IS NULL OR p.owner_id = @owner_id)
          AND (@status IS NULL OR c.status = @status)
          AND (@expiring IS NULL OR (c.status = 'Active'
               AND c.end_date BETWEEN CAST(SYSDATETIME() AS DATE) AND DATEADD(DAY, @expiring, CAST(SYSDATETIME() AS DATE))))
          AND (@search IS NULL OR c.contract_number LIKE '%' + @search + '%' OR c.supplier_name LIKE '%' + @search + '%')`;

    const result = await db.request()
        .input('procurement_id', sql.Int, query.procurement_id ?? null)
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('owner_id', sql.Int, query.owner_id ?? null)
        .input('status', sql.NVarChar(20), query.status ?? null)
        .input('expiring', sql.Int, query.expiring_within_days ?? null)
        .input('search', sql.NVarChar(100), query.search ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total ${DISPLAY_JOINS} ${where};

            SELECT ${DISPLAY_SELECT} ${DISPLAY_JOINS} ${where}
            ORDER BY c.end_date ASC, c.contract_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// One contract with its invoices
export const getContractDetailService = async (contractId: number) => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, contractId)
        .query(`
            SELECT ${DISPLAY_SELECT} ${DISPLAY_JOINS}
            WHERE c.contract_id = @id AND c.is_deleted = 0;

            SELECT i.invoice_id, i.invoice_number, i.amount, i.invoice_date, i.received_date, i.status,
                   ISNULL((SELECT SUM(amount) FROM dbo.Payments WHERE invoice_id = i.invoice_id AND is_deleted = 0), 0) AS paid_amount
            FROM dbo.Invoices i
            WHERE i.contract_id = @id AND i.is_deleted = 0
            ORDER BY i.received_date DESC;
        `);

    const [contracts, invoices] = result.recordsets as sql.IRecordSet<any>[];
    if (contracts.length === 0) return null;
    return { ...contracts[0], invoices };
};

// Raw row (not deleted) with the procurement owner - for access checks
export const getContractRowService = async (contractId: number): Promise<ContractRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, contractId)
        .query(`SELECT c.contract_id, c.procurement_id, c.contract_number, c.supplier_name, c.contract_value,
                       CONVERT(CHAR(10), c.start_date, 23) AS start_date, CONVERT(CHAR(10), c.end_date, 23) AS end_date,
                       c.status, c.notes, p.owner_id
                FROM dbo.Contracts c
                JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id
                WHERE c.contract_id = @id AND c.is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// ------------------------------- Commands ------------------------------------

// Create a contract for a procurement
export const createContractService = async (input: CreateContractInput, actorId: number): Promise<number> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('procurement_id', sql.Int, input.procurement_id)
            .input('contract_number', sql.NVarChar(50), input.contract_number)
            .input('supplier_name', sql.NVarChar(200), input.supplier_name)
            .input('contract_value', sql.Decimal(18, 2), input.contract_value)
            .input('start_date', sql.Date, input.start_date)
            .input('end_date', sql.Date, input.end_date)
            .input('status', sql.NVarChar(20), input.status)
            .input('notes', sql.NVarChar(sql.MAX), input.notes)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Contracts (procurement_id, contract_number, supplier_name, contract_value, start_date, end_date, status, notes, created_by)
                    OUTPUT INSERTED.contract_id
                    VALUES (@procurement_id, @contract_number, @supplier_name, @contract_value, @start_date, @end_date, @status, @notes, @created_by)`);

        const contractId: number = result.recordset[0].contract_id;
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Contracts', entityId: contractId, newValues: input });
        return contractId;
    });
};

// Update a contract. Only fields present in `input` change.
export const updateContractService = async (before: ContractRow, input: UpdateContractInput, actorId: number): Promise<void> => {
    const startDate = input.start_date ?? before.start_date;
    const endDate = input.end_date ?? before.end_date;
    if (endDate < startDate) {
        throw new HttpError(400, 'end_date cannot be before start_date');
    }

    await withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('id', sql.Int, before.contract_id)
            .input('contract_number', sql.NVarChar(50), input.contract_number ?? before.contract_number)
            .input('supplier_name', sql.NVarChar(200), input.supplier_name ?? before.supplier_name)
            .input('contract_value', sql.Decimal(18, 2), input.contract_value ?? before.contract_value)
            .input('start_date', sql.Date, startDate)
            .input('end_date', sql.Date, endDate)
            .input('status', sql.NVarChar(20), input.status ?? before.status)
            .input('notes', sql.NVarChar(sql.MAX), input.notes === undefined ? before.notes : input.notes)
            .query(`
                DECLARE @invoiced DECIMAL(18,2) = (
                    SELECT ISNULL(SUM(amount), 0) FROM dbo.Invoices
                    WHERE contract_id = @id AND is_deleted = 0 AND status <> 'Rejected');

                IF @contract_value < @invoiced
                BEGIN
                    SELECT CAST(0 AS BIT) AS ok, @invoiced AS invoiced;
                    RETURN;
                END

                UPDATE dbo.Contracts
                SET contract_number = @contract_number, supplier_name = @supplier_name, contract_value = @contract_value,
                    start_date = @start_date, end_date = @end_date, status = @status, notes = @notes,
                    updated_at = SYSUTCDATETIME()
                WHERE contract_id = @id;

                SELECT CAST(1 AS BIT) AS ok, @invoiced AS invoiced;`);

        const { ok, invoiced } = result.recordset[0];
        if (!ok) {
            throw new HttpError(400, `Contract value cannot be less than the amount already invoiced (${Number(invoiced).toLocaleString()})`);
        }
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Contracts', entityId: before.contract_id, oldValues: before, newValues: input });
    });
};

// Soft-delete a contract (refused while it has invoices)
export const deleteContractService = async (before: ContractRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        const invoices = await new sql.Request(tx)
            .input('id', sql.Int, before.contract_id)
            .query(`SELECT COUNT(*) AS total FROM dbo.Invoices WHERE contract_id = @id AND is_deleted = 0`);
        if (invoices.recordset[0].total > 0) {
            throw new HttpError(409, 'This contract has invoices. Delete the invoices first.');
        }

        await new sql.Request(tx)
            .input('id', sql.Int, before.contract_id)
            .query(`UPDATE dbo.Contracts SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE contract_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Contracts', entityId: before.contract_id, oldValues: before });
    });
};
