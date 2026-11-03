import sql from 'mssql';
import type { QuarterRange } from '../validators/common.validators.js';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import type { CreateMemoInput, MemoQuery, UpdateMemoInput } from '../validators/memo.validators.js';

/**
 * Memos service - memos to the DG requesting a procurement.
 */

/** Raw row from dbo.Memos. */
export interface MemoRow {
    memo_id: number;
    reference: string | null;
    title: string;
    fy_id: number;
    owner_id: number;
    category_id: number;
    priority_id: number | null;
    delivered_date: string | null;
    approved_date: string | null;
    dg_status: string | null;
    status: string;
    notes: string | null;
}

const ROW_COLUMNS = `memo_id, reference, title, fy_id, owner_id, category_id, priority_id,
    CONVERT(CHAR(10), delivered_date, 23) AS delivered_date,
    CONVERT(CHAR(10), approved_date, 23) AS approved_date,
    dg_status, status, notes`;

// Paginated, filterable list of memos, in tracker order
export const listMemosService = async (query: MemoQuery & QuarterRange) => {
    const db = getDbPool();
    const from = `
        FROM dbo.Memos m
        JOIN dbo.FinancialYears fy ON fy.fy_id = m.fy_id
        JOIN dbo.Users u           ON u.user_id = m.owner_id
        JOIN dbo.Lookups cat       ON cat.lookup_id = m.category_id
        LEFT JOIN dbo.Lookups pr   ON pr.lookup_id = m.priority_id
        WHERE m.is_deleted = 0
          AND (@fy_id IS NULL OR m.fy_id = @fy_id)
          AND (@quarter_from IS NULL OR m.delivered_date BETWEEN @quarter_from AND @quarter_to)
          AND (@status IS NULL OR m.status = @status)
          AND (@category_id IS NULL OR m.category_id = @category_id)
          AND (@owner_id IS NULL OR m.owner_id = @owner_id)
          AND (@search IS NULL OR m.title LIKE '%' + @search + '%' OR m.reference LIKE '%' + @search + '%')`;

    const result = await db.request()
        .input('quarter_from', sql.Date, query.quarter_from ?? null)
        .input('quarter_to', sql.Date, query.quarter_to ?? null)
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('status', sql.NVarChar(20), query.status ?? null)
        .input('category_id', sql.Int, query.category_id ?? null)
        .input('owner_id', sql.Int, query.owner_id ?? null)
        .input('search', sql.NVarChar(100), query.search ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total ${from};

            SELECT m.memo_id, m.reference, m.title, m.fy_id, fy.code AS fy_code,
                   m.owner_id, u.full_name AS owner_name,
                   m.category_id, cat.value AS category,
                   m.priority_id, pr.value AS priority,
                   CONVERT(CHAR(10), m.delivered_date, 23) AS delivered_date,
                   CONVERT(CHAR(10), m.approved_date, 23) AS approved_date,
                   m.dg_status, m.status, m.notes, m.created_at, m.updated_at
            ${from}
            ORDER BY m.reference, m.memo_id
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// Raw row (not deleted)
export const getMemoRowService = async (memoId: number): Promise<MemoRow | null> => {
    const result = await getDbPool().request()
        .input('id', sql.Int, memoId)
        .query(`SELECT ${ROW_COLUMNS} FROM dbo.Memos WHERE memo_id = @id AND is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// Binds every editable column to a request
const bindMemoFields = (request: sql.Request, m: Omit<MemoRow, 'memo_id'>) =>
    request
        .input('reference', sql.NVarChar(30), m.reference)
        .input('title', sql.NVarChar(500), m.title)
        .input('fy_id', sql.Int, m.fy_id)
        .input('owner_id', sql.Int, m.owner_id)
        .input('category_id', sql.Int, m.category_id)
        .input('priority_id', sql.Int, m.priority_id)
        .input('delivered_date', sql.Date, m.delivered_date)
        .input('approved_date', sql.Date, m.approved_date)
        .input('dg_status', sql.NVarChar(20), m.dg_status)
        .input('status', sql.NVarChar(20), m.status)
        .input('notes', sql.NVarChar(sql.MAX), m.notes);

// Create a memo
export const createMemoService = async (input: Omit<CreateMemoInput, 'owner_id'> & { owner_id: number }, actorId: number): Promise<MemoRow> => {
    return withTransaction(async (tx) => {
        const fields = {
            ...input,
            priority_id: input.priority_id ?? null,
            delivered_date: input.delivered_date ?? null,
            approved_date: input.approved_date ?? null,
            dg_status: input.dg_status ?? null,
        };
        const result = await bindMemoFields(new sql.Request(tx), fields)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Memos (reference, title, fy_id, owner_id, category_id, priority_id, delivered_date, approved_date, dg_status, status, notes, created_by)
                    OUTPUT INSERTED.memo_id
                    VALUES (@reference, @title, @fy_id, @owner_id, @category_id, @priority_id, @delivered_date, @approved_date, @dg_status, @status, @notes, @created_by);`);

        const memoId: number = result.recordset[0].memo_id;
        const memo = (await new sql.Request(tx)
            .input('id', sql.Int, memoId)
            .query(`SELECT ${ROW_COLUMNS} FROM dbo.Memos WHERE memo_id = @id`)).recordset[0] as MemoRow;

        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Memos', entityId: memoId, newValues: memo });
        return memo;
    });
};

// Update a memo. Only fields present in `input` change.
export const updateMemoService = async (before: MemoRow, input: UpdateMemoInput, actorId: number): Promise<MemoRow> => {
    const pick = <K extends keyof UpdateMemoInput & keyof MemoRow>(key: K) =>
        (input[key] === undefined ? before[key] : input[key]) as MemoRow[K];

    const merged = {
        reference: pick('reference'),
        title: pick('title'),
        fy_id: pick('fy_id'),
        owner_id: pick('owner_id'),
        category_id: pick('category_id'),
        priority_id: pick('priority_id'),
        delivered_date: pick('delivered_date'),
        approved_date: pick('approved_date'),
        dg_status: pick('dg_status'),
        status: pick('status'),
        notes: pick('notes'),
    };

    if (merged.delivered_date && merged.approved_date && merged.approved_date < merged.delivered_date) {
        throw new HttpError(400, 'approved_date cannot be before delivered_date');
    }

    return withTransaction(async (tx) => {
        const result = await bindMemoFields(new sql.Request(tx), merged)
            .input('id', sql.Int, before.memo_id)
            .query(`UPDATE dbo.Memos
                    SET reference = @reference, title = @title, fy_id = @fy_id, owner_id = @owner_id, category_id = @category_id,
                        priority_id = @priority_id, delivered_date = @delivered_date, approved_date = @approved_date,
                        dg_status = @dg_status, status = @status, notes = @notes, updated_at = SYSUTCDATETIME()
                    WHERE memo_id = @id;
                    SELECT ${ROW_COLUMNS} FROM dbo.Memos WHERE memo_id = @id;`);

        const after: MemoRow = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Memos', entityId: before.memo_id, oldValues: before, newValues: after });
        return after;
    });
};

// Soft-delete a memo
export const deleteMemoService = async (before: MemoRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        await new sql.Request(tx)
            .input('id', sql.Int, before.memo_id)
            .query(`UPDATE dbo.Memos SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE memo_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Memos', entityId: before.memo_id, oldValues: before });
    });
};
