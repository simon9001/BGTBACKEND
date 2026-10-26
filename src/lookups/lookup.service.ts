import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import type { CreateLookupInput, LookupType, UpdateLookupInput } from '../validators/settings.validators.js';

/**
 * Lookups service - dropdown values (replaces the "Lists" sheet).
 */

export interface Lookup {
    lookup_id: number;
    lookup_type: LookupType;
    value: string;
    sort_order: number;
    is_active: boolean;
}

const COLUMNS = 'lookup_id, lookup_type, value, sort_order, is_active';

// List lookups, optionally of one type
export const getLookupsService = async (type: LookupType | undefined, includeInactive: boolean): Promise<Lookup[]> => {
    const db = getDbPool();
    const result = await db.request()
        .input('type', sql.NVarChar(50), type ?? null)
        .input('include_inactive', sql.Bit, includeInactive)
        .query(`SELECT ${COLUMNS} FROM dbo.Lookups
                WHERE (@type IS NULL OR lookup_type = @type)
                  AND (@include_inactive = 1 OR is_active = 1)
                ORDER BY lookup_type, sort_order, value`);
    return result.recordset;
};

// Get one lookup
export const getLookupByIdService = async (lookupId: number): Promise<Lookup | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('lookup_id', sql.Int, lookupId)
        .query(`SELECT ${COLUMNS} FROM dbo.Lookups WHERE lookup_id = @lookup_id`);
    return result.recordset[0] ?? null;
};

// Create a lookup value
export const createLookupService = async (input: CreateLookupInput, actorId: number): Promise<Lookup> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('lookup_type', sql.NVarChar(50), input.lookup_type)
            .input('value', sql.NVarChar(150), input.value)
            .input('sort_order', sql.Int, input.sort_order)
            .query(`INSERT INTO dbo.Lookups (lookup_type, value, sort_order)
                    OUTPUT INSERTED.lookup_id, INSERTED.lookup_type, INSERTED.value, INSERTED.sort_order, INSERTED.is_active
                    VALUES (@lookup_type, @value, @sort_order)`);

        const lookup: Lookup = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Lookups', entityId: lookup.lookup_id, newValues: lookup });
        return lookup;
    });
};

// Rename / reorder / (de)activate a lookup value
export const updateLookupService = async (lookupId: number, input: UpdateLookupInput, actorId: number): Promise<Lookup | null> => {
    const before = await getLookupByIdService(lookupId);
    if (!before) return null;

    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('lookup_id', sql.Int, lookupId)
            .input('value', sql.NVarChar(150), input.value ?? before.value)
            .input('sort_order', sql.Int, input.sort_order ?? before.sort_order)
            .input('is_active', sql.Bit, input.is_active ?? before.is_active)
            .query(`UPDATE dbo.Lookups SET value = @value, sort_order = @sort_order, is_active = @is_active
                    OUTPUT INSERTED.lookup_id, INSERTED.lookup_type, INSERTED.value, INSERTED.sort_order, INSERTED.is_active
                    WHERE lookup_id = @lookup_id`);

        const after: Lookup = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Lookups', entityId: lookupId, oldValues: before, newValues: after });
        return after;
    });
};

/**
 * Ensures each referenced lookup id exists, is active and is of the expected
 * type (e.g. category_id really points at a category). Null ids are skipped.
 * Throws HttpError(400) naming the offending field.
 */
export const assertLookups = async (checks: { field: string; id: number | null | undefined; type: LookupType }[]) => {
    const toCheck = checks.filter((check) => check.id != null);
    if (toCheck.length === 0) return;

    const db = getDbPool();
    const request = db.request();
    toCheck.forEach((check, i) => request.input(`id${i}`, sql.Int, check.id));

    const result = await request.query(
        `SELECT lookup_id, lookup_type, is_active FROM dbo.Lookups
         WHERE lookup_id IN (${toCheck.map((_, i) => `@id${i}`).join(', ')})`,
    );
    const found = new Map<number, { lookup_type: string; is_active: boolean }>(
        result.recordset.map((row) => [row.lookup_id, row]),
    );

    for (const check of toCheck) {
        const row = found.get(check.id as number);
        if (!row || row.lookup_type !== check.type || !row.is_active) {
            throw new HttpError(400, `${check.field} must be an active ${check.type.replace('_', ' ')}`);
        }
    }
};
