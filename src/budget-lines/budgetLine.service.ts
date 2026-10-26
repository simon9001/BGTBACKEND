import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import { sumAmounts, toCents } from '../utils/money.js';
import type {
    AllocationInput,
    BudgetLineQuery,
    CreateBudgetLineInput,
    UpdateBudgetLineInput,
} from '../validators/budgetLine.validators.js';

/**
 * Budget lines service.
 *
 * Rule: the planned amounts across all financial years may not exceed the
 * line's total cost (quantity x unit price).
 */

/** Raw row from dbo.BudgetLines (used for ownership checks and audit). */
export interface BudgetLineRow {
    budget_line_id: number;
    code: string | null;
    description: string;
    category_id: number;
    priority_id: number | null;
    owner_id: number;
    quantity: number;
    unit_price: number;
    total_amount: number;
    notes: string | null;
}

const ROW_COLUMNS = 'budget_line_id, code, description, category_id, priority_id, owner_id, quantity, unit_price, total_amount, notes';

// SELECT list shared by the list and detail queries (display names included)
const DISPLAY_SELECT = `
    bl.budget_line_id, bl.code, bl.description,
    bl.category_id, cat.value AS category,
    bl.priority_id, pr.value AS priority,
    bl.owner_id, u.full_name AS owner_name,
    bl.quantity, bl.unit_price, bl.total_amount, bl.notes, bl.created_at, bl.updated_at,
    (SELECT ISNULL(SUM(a.planned_amount), 0) FROM dbo.BudgetAllocations a WHERE a.budget_line_id = bl.budget_line_id) AS allocated_amount`;

const DISPLAY_JOINS = `
    FROM dbo.BudgetLines bl
    JOIN dbo.Lookups cat     ON cat.lookup_id = bl.category_id
    LEFT JOIN dbo.Lookups pr ON pr.lookup_id = bl.priority_id
    JOIN dbo.Users u         ON u.user_id = bl.owner_id`;

// ------------------------------- Queries -------------------------------------

// Paginated list with filters. With fy_id, each row also carries that year's plan.
export const listBudgetLinesService = async (query: BudgetLineQuery) => {
    const db = getDbPool();
    const from = `${DISPLAY_JOINS}
        LEFT JOIN dbo.BudgetAllocations fa ON fa.budget_line_id = bl.budget_line_id AND fa.fy_id = @fy_id
        WHERE bl.is_deleted = 0
          AND (@fy_id IS NULL OR fa.allocation_id IS NOT NULL)
          AND (@category_id IS NULL OR bl.category_id = @category_id)
          AND (@owner_id IS NULL OR bl.owner_id = @owner_id)
          AND (@search IS NULL OR bl.description LIKE '%' + @search + '%' OR bl.code LIKE '%' + @search + '%')`;

    const result = await db.request()
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('category_id', sql.Int, query.category_id ?? null)
        .input('owner_id', sql.Int, query.owner_id ?? null)
        .input('search', sql.NVarChar(100), query.search ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total ${from};

            SELECT ${DISPLAY_SELECT},
                   fa.planned_amount AS fy_planned_amount,
                   fa.q1_amount AS fy_q1_amount, fa.q2_amount AS fy_q2_amount,
                   fa.q3_amount AS fy_q3_amount, fa.q4_amount AS fy_q4_amount
            ${from}
            ORDER BY cat.sort_order, bl.code, bl.description
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// One budget line with its yearly allocations and linked procurements
export const getBudgetLineDetailService = async (budgetLineId: number) => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, budgetLineId)
        .query(`
            SELECT ${DISPLAY_SELECT} ${DISPLAY_JOINS}
            WHERE bl.budget_line_id = @id AND bl.is_deleted = 0;

            SELECT a.allocation_id, a.fy_id, fy.code AS fy_code, a.planned_amount,
                   a.q1_amount, a.q2_amount, a.q3_amount, a.q4_amount
            FROM dbo.BudgetAllocations a
            JOIN dbo.FinancialYears fy ON fy.fy_id = a.fy_id
            WHERE a.budget_line_id = @id
            ORDER BY fy.start_date;

            SELECT procurement_id, reference, title, fy_code, status, current_stage_name, progress_percent, is_overdue
            FROM dbo.vw_Procurements
            WHERE budget_line_id = @id
            ORDER BY created_at DESC;
        `);

    const [lines, allocations, procurements] = result.recordsets as sql.IRecordSet<any>[];
    if (lines.length === 0) return null;
    return { ...lines[0], allocations, procurements };
};

// Raw row (not deleted) - for ownership checks before changes
export const getBudgetLineRowService = async (budgetLineId: number): Promise<BudgetLineRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, budgetLineId)
        .query(`SELECT ${ROW_COLUMNS} FROM dbo.BudgetLines WHERE budget_line_id = @id AND is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// ------------------------------- Helpers -------------------------------------

// Sum of planned amounts for a line, optionally excluding one financial year
const getAllocatedTotal = async (tx: sql.Transaction, budgetLineId: number, excludeFyId: number | null): Promise<number> => {
    const result = await new sql.Request(tx)
        .input('id', sql.Int, budgetLineId)
        .input('exclude_fy_id', sql.Int, excludeFyId)
        .query(`SELECT ISNULL(SUM(planned_amount), 0) AS total FROM dbo.BudgetAllocations
                WHERE budget_line_id = @id AND (@exclude_fy_id IS NULL OR fy_id <> @exclude_fy_id)`);
    return Number(result.recordset[0].total);
};

const assertWithinTotal = (allocated: number, total: number) => {
    if (toCents(allocated) > toCents(total)) {
        throw new HttpError(400,
            `Planned amounts across financial years (${allocated.toLocaleString()}) exceed the line total (${total.toLocaleString()})`);
    }
};

// Insert or update the allocation of one financial year
const upsertAllocation = async (tx: sql.Transaction, budgetLineId: number, fyId: number, a: AllocationInput) => {
    await new sql.Request(tx)
        .input('budget_line_id', sql.Int, budgetLineId)
        .input('fy_id', sql.Int, fyId)
        .input('planned_amount', sql.Decimal(18, 2), a.planned_amount)
        .input('q1', sql.Decimal(18, 2), a.q1_amount)
        .input('q2', sql.Decimal(18, 2), a.q2_amount)
        .input('q3', sql.Decimal(18, 2), a.q3_amount)
        .input('q4', sql.Decimal(18, 2), a.q4_amount)
        .query(`
            MERGE dbo.BudgetAllocations WITH (HOLDLOCK) AS target
            USING (SELECT @budget_line_id AS budget_line_id, @fy_id AS fy_id) AS src
               ON target.budget_line_id = src.budget_line_id AND target.fy_id = src.fy_id
            WHEN MATCHED THEN
                UPDATE SET planned_amount = @planned_amount, q1_amount = @q1, q2_amount = @q2, q3_amount = @q3, q4_amount = @q4
            WHEN NOT MATCHED THEN
                INSERT (budget_line_id, fy_id, planned_amount, q1_amount, q2_amount, q3_amount, q4_amount)
                VALUES (@budget_line_id, @fy_id, @planned_amount, @q1, @q2, @q3, @q4);`);
};

// ------------------------------- Commands ------------------------------------

// Create a budget line together with its yearly allocations
export const createBudgetLineService = async (
    input: Omit<CreateBudgetLineInput, 'owner_id'> & { owner_id: number },
    actorId: number,
): Promise<number> => {
    const total = input.quantity * input.unit_price;
    assertWithinTotal(sumAmounts(input.allocations.map((a) => a.planned_amount)), total);

    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('code', sql.NVarChar(20), input.code)
            .input('description', sql.NVarChar(500), input.description)
            .input('category_id', sql.Int, input.category_id)
            .input('priority_id', sql.Int, input.priority_id ?? null)
            .input('owner_id', sql.Int, input.owner_id)
            .input('quantity', sql.Int, input.quantity)
            .input('unit_price', sql.Decimal(18, 2), input.unit_price)
            .input('notes', sql.NVarChar(sql.MAX), input.notes)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.BudgetLines (code, description, category_id, priority_id, owner_id, quantity, unit_price, notes, created_by)
                    OUTPUT INSERTED.budget_line_id
                    VALUES (@code, @description, @category_id, @priority_id, @owner_id, @quantity, @unit_price, @notes, @created_by)`);

        const budgetLineId: number = result.recordset[0].budget_line_id;
        for (const allocation of input.allocations) {
            await upsertAllocation(tx, budgetLineId, allocation.fy_id, allocation);
        }

        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'BudgetLines', entityId: budgetLineId, newValues: input });
        return budgetLineId;
    });
};

// Update a budget line's own fields (allocations have their own endpoint)
export const updateBudgetLineService = async (before: BudgetLineRow, input: UpdateBudgetLineInput, actorId: number): Promise<void> => {
    const quantity = input.quantity ?? before.quantity;
    const unitPrice = input.unit_price ?? Number(before.unit_price);

    await withTransaction(async (tx) => {
        // Price/quantity changes must still cover what is already allocated
        assertWithinTotal(await getAllocatedTotal(tx, before.budget_line_id, null), quantity * unitPrice);

        const result = await new sql.Request(tx)
            .input('id', sql.Int, before.budget_line_id)
            .input('code', sql.NVarChar(20), input.code === undefined ? before.code : input.code)
            .input('description', sql.NVarChar(500), input.description ?? before.description)
            .input('category_id', sql.Int, input.category_id ?? before.category_id)
            .input('priority_id', sql.Int, input.priority_id === undefined ? before.priority_id : input.priority_id)
            .input('owner_id', sql.Int, input.owner_id ?? before.owner_id)
            .input('quantity', sql.Int, quantity)
            .input('unit_price', sql.Decimal(18, 2), unitPrice)
            .input('notes', sql.NVarChar(sql.MAX), input.notes === undefined ? before.notes : input.notes)
            .query(`UPDATE dbo.BudgetLines
                    SET code = @code, description = @description, category_id = @category_id, priority_id = @priority_id,
                        owner_id = @owner_id, quantity = @quantity, unit_price = @unit_price, notes = @notes,
                        updated_at = SYSUTCDATETIME()
                    OUTPUT ${ROW_COLUMNS.split(', ').map((col) => `INSERTED.${col}`).join(', ')}
                    WHERE budget_line_id = @id`);

        await writeAudit(tx, {
            userId: actorId, action: 'UPDATE', entity: 'BudgetLines', entityId: before.budget_line_id,
            oldValues: before, newValues: result.recordset[0],
        });
    });
};

// Set the planned spend of a line for one financial year
export const setAllocationService = async (line: BudgetLineRow, fyId: number, input: AllocationInput, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        const otherYears = await getAllocatedTotal(tx, line.budget_line_id, fyId);
        assertWithinTotal(otherYears + input.planned_amount, Number(line.total_amount));

        await upsertAllocation(tx, line.budget_line_id, fyId, input);
        await writeAudit(tx, {
            userId: actorId, action: 'UPDATE', entity: 'BudgetLines', entityId: line.budget_line_id,
            newValues: { allocation: { fy_id: fyId, ...input } },
        });
    });
};

// Remove the allocation of one financial year. Returns false if there was none.
export const deleteAllocationService = async (line: BudgetLineRow, fyId: number, actorId: number): Promise<boolean> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('id', sql.Int, line.budget_line_id)
            .input('fy_id', sql.Int, fyId)
            .query(`DELETE FROM dbo.BudgetAllocations
                    OUTPUT DELETED.*
                    WHERE budget_line_id = @id AND fy_id = @fy_id`);

        if (result.recordset.length === 0) return false;
        await writeAudit(tx, {
            userId: actorId, action: 'UPDATE', entity: 'BudgetLines', entityId: line.budget_line_id,
            oldValues: { allocation: result.recordset[0] }, newValues: { allocation: null },
        });
        return true;
    });
};

// Soft-delete a budget line (refused while procurements still reference it)
export const deleteBudgetLineService = async (line: BudgetLineRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        const linked = await new sql.Request(tx)
            .input('id', sql.Int, line.budget_line_id)
            .query(`SELECT COUNT(*) AS total FROM dbo.Procurements WHERE budget_line_id = @id AND is_deleted = 0`);
        if (linked.recordset[0].total > 0) {
            throw new HttpError(409, 'This budget line has procurements linked to it. Remove or relink them first.');
        }

        await new sql.Request(tx)
            .input('id', sql.Int, line.budget_line_id)
            .query(`UPDATE dbo.BudgetLines SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE budget_line_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'BudgetLines', entityId: line.budget_line_id, oldValues: line });
    });
};
