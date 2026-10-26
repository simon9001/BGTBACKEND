import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import type { CreateFinancialYearInput, UpdateFinancialYearInput } from '../validators/settings.validators.js';

/**
 * Financial years service.
 * The system spans many years; exactly one is flagged as "current" and is the
 * default filter on the dashboard.
 */

export interface FinancialYear {
    fy_id: number;
    code: string;
    start_date: Date;
    end_date: Date;
    is_current: boolean;
}

const COLUMNS = 'fy_id, code, start_date, end_date, is_current';

// All financial years, newest first
export const getFinancialYearsService = async (): Promise<FinancialYear[]> => {
    const db = getDbPool();
    const result = await db.request().query(`SELECT ${COLUMNS} FROM dbo.FinancialYears ORDER BY start_date DESC`);
    return result.recordset;
};

// One financial year
export const getFinancialYearByIdService = async (fyId: number): Promise<FinancialYear | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('fy_id', sql.Int, fyId)
        .query(`SELECT ${COLUMNS} FROM dbo.FinancialYears WHERE fy_id = @fy_id`);
    return result.recordset[0] ?? null;
};

// The year flagged as current (null if none is set yet)
export const getCurrentFinancialYearService = async (): Promise<FinancialYear | null> => {
    const db = getDbPool();
    const result = await db.request().query(`SELECT ${COLUMNS} FROM dbo.FinancialYears WHERE is_current = 1`);
    return result.recordset[0] ?? null;
};

// Throws 400 if the date range overlaps another year
const assertNoOverlap = async (tx: sql.Transaction, startDate: string, endDate: string, excludeId: number | null) => {
    const result = await new sql.Request(tx)
        .input('start_date', sql.Date, startDate)
        .input('end_date', sql.Date, endDate)
        .input('exclude_id', sql.Int, excludeId)
        .query(`SELECT TOP 1 code FROM dbo.FinancialYears
                WHERE start_date <= @end_date AND end_date >= @start_date
                  AND (@exclude_id IS NULL OR fy_id <> @exclude_id)`);
    if (result.recordset.length > 0) {
        throw new HttpError(400, `Dates overlap with financial year ${result.recordset[0].code}`);
    }
};

// Create a financial year
export const createFinancialYearService = async (input: CreateFinancialYearInput, actorId: number): Promise<FinancialYear> => {
    return withTransaction(async (tx) => {
        await assertNoOverlap(tx, input.start_date, input.end_date, null);

        const result = await new sql.Request(tx)
            .input('code', sql.NVarChar(9), input.code)
            .input('start_date', sql.Date, input.start_date)
            .input('end_date', sql.Date, input.end_date)
            .query(`INSERT INTO dbo.FinancialYears (code, start_date, end_date)
                    OUTPUT INSERTED.fy_id, INSERTED.code, INSERTED.start_date, INSERTED.end_date, INSERTED.is_current
                    VALUES (@code, @start_date, @end_date)`);

        const fy: FinancialYear = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'FinancialYears', entityId: fy.fy_id, newValues: fy });
        return fy;
    });
};

// Update code / dates of a financial year
export const updateFinancialYearService = async (fyId: number, input: UpdateFinancialYearInput, actorId: number): Promise<FinancialYear | null> => {
    const before = await getFinancialYearByIdService(fyId);
    if (!before) return null;

    const startDate = input.start_date ?? before.start_date.toISOString().slice(0, 10);
    const endDate = input.end_date ?? before.end_date.toISOString().slice(0, 10);
    if (endDate <= startDate) {
        throw new HttpError(400, 'end_date must be after start_date');
    }

    return withTransaction(async (tx) => {
        await assertNoOverlap(tx, startDate, endDate, fyId);

        const result = await new sql.Request(tx)
            .input('fy_id', sql.Int, fyId)
            .input('code', sql.NVarChar(9), input.code ?? before.code)
            .input('start_date', sql.Date, startDate)
            .input('end_date', sql.Date, endDate)
            .query(`UPDATE dbo.FinancialYears SET code = @code, start_date = @start_date, end_date = @end_date
                    OUTPUT INSERTED.fy_id, INSERTED.code, INSERTED.start_date, INSERTED.end_date, INSERTED.is_current
                    WHERE fy_id = @fy_id`);

        const after: FinancialYear = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'FinancialYears', entityId: fyId, oldValues: before, newValues: after });
        return after;
    });
};

// Make one year the current year (clears the flag on all others)
export const setCurrentFinancialYearService = async (fyId: number, actorId: number): Promise<FinancialYear | null> => {
    const before = await getFinancialYearByIdService(fyId);
    if (!before) return null;

    return withTransaction(async (tx) => {
        await new sql.Request(tx).query(`UPDATE dbo.FinancialYears SET is_current = 0 WHERE is_current = 1`);
        const result = await new sql.Request(tx)
            .input('fy_id', sql.Int, fyId)
            .query(`UPDATE dbo.FinancialYears SET is_current = 1
                    OUTPUT INSERTED.fy_id, INSERTED.code, INSERTED.start_date, INSERTED.end_date, INSERTED.is_current
                    WHERE fy_id = @fy_id`);

        const after: FinancialYear = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'FinancialYears', entityId: fyId, oldValues: before, newValues: after });
        return after;
    });
};
