import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { HttpError } from '../utils/http-error.js';
import { toOffset } from '../utils/pagination.js';
import type {
    CreateProcurementInput,
    ProcurementQuery,
    RecordStageEventInput,
    UpdateProcurementInput,
} from '../validators/procurement.validators.js';

/**
 * Procurements service.
 *
 * Read queries use dbo.vw_Procurements, which adds display names and the live
 * tracking figures (days_in_stage, is_overdue, progress_percent).
 *
 * Stage tracking: every step update is inserted into StageEvents, then
 * `recomputeCurrentStage` works out where the item is now:
 *   - latest event Approved/Completed -> item moves to the NEXT active step
 *   - any other status (Pending, Rejected, Returned ...) -> item stays at that step
 * "Latest" is by event date, so officers can back-fill older updates safely.
 */

/** Raw row from dbo.Procurements (used for ownership checks, updates and audit). */
export interface ProcurementRow {
    procurement_id: number;
    reference: string | null;
    title: string;
    budget_line_id: number | null;
    fy_id: number;
    owner_id: number;
    category_id: number;
    priority_id: number | null;
    acquisition_method_id: number | null;
    scm_officer_id: number | null;
    status: string;
    current_stage_id: number | null;
    stage_entered_at: Date | null;
    tender_float_date: string | null;
    tender_opening_date: string | null;
    is_escalated: boolean;
    escalated_to: string | null;
    escalation_note: string | null;
    notes: string | null;
}

const ROW_COLUMNS = `procurement_id, reference, title, budget_line_id, fy_id, owner_id, category_id, priority_id,
    acquisition_method_id, scm_officer_id, status, current_stage_id, stage_entered_at,
    CONVERT(CHAR(10), tender_float_date, 23) AS tender_float_date,
    CONVERT(CHAR(10), tender_opening_date, 23) AS tender_opening_date,
    is_escalated, escalated_to, escalation_note, notes`;

// Whitelisted ORDER BY clauses for the list endpoint
const SORTS: Record<ProcurementQuery['sort'], string> = {
    newest: 'created_at DESC',
    priority: 'priority_rank DESC, days_in_stage DESC',
    days_in_stage: 'days_in_stage DESC',
    title: 'title ASC',
};

// ------------------------------- Queries -------------------------------------

// Paginated, filterable list of procurements
export const listProcurementsService = async (query: ProcurementQuery, currentUserId: number) => {
    const db = getDbPool();
    const where = `
        WHERE (@fy_id IS NULL OR fy_id = @fy_id)
          AND (@status IS NULL OR status = @status)
          AND (@category_id IS NULL OR category_id = @category_id)
          AND (@owner_id IS NULL OR owner_id = @owner_id)
          AND (@stage_id IS NULL OR current_stage_id = @stage_id)
          AND (@budget_line_id IS NULL OR budget_line_id = @budget_line_id)
          AND (@is_escalated IS NULL OR is_escalated = @is_escalated)
          AND (@overdue IS NULL OR is_overdue = @overdue)
          AND (@search IS NULL OR title LIKE '%' + @search + '%' OR reference LIKE '%' + @search + '%')`;

    const result = await db.request()
        .input('fy_id', sql.Int, query.fy_id ?? null)
        .input('status', sql.NVarChar(20), query.status ?? null)
        .input('category_id', sql.Int, query.category_id ?? null)
        .input('owner_id', sql.Int, query.mine ? currentUserId : (query.owner_id ?? null))
        .input('stage_id', sql.Int, query.stage_id ?? null)
        .input('budget_line_id', sql.Int, query.budget_line_id ?? null)
        .input('is_escalated', sql.Bit, query.is_escalated ?? null)
        .input('overdue', sql.Bit, query.overdue ?? null)
        .input('search', sql.NVarChar(100), query.search ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total FROM dbo.vw_Procurements ${where};

            SELECT * FROM dbo.vw_Procurements ${where}
            ORDER BY ${SORTS[query.sort]}, procurement_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// One procurement with its step history, contracts and open tasks
export const getProcurementDetailService = async (procurementId: number) => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, procurementId)
        .query(`
            SELECT * FROM dbo.vw_Procurements WHERE procurement_id = @id;

            SELECT e.event_id, e.stage_id, ws.code AS stage_code, ws.name AS stage_name, ws.stage_group,
                   e.status, e.event_date, e.notes, e.recorded_by, u.full_name AS recorded_by_name, e.created_at
            FROM dbo.StageEvents e
            JOIN dbo.WorkflowStages ws ON ws.stage_id = e.stage_id
            JOIN dbo.Users u ON u.user_id = e.recorded_by
            WHERE e.procurement_id = @id
            ORDER BY e.event_date DESC, ws.sort_order DESC, e.event_id DESC;

            SELECT contract_id, contract_number, supplier_name, contract_value, start_date, end_date, status
            FROM dbo.Contracts
            WHERE procurement_id = @id AND is_deleted = 0
            ORDER BY start_date DESC;

            SELECT task_id, title, owner_id, due_date, status
            FROM dbo.Tasks
            WHERE procurement_id = @id AND is_deleted = 0 AND status IN ('Open', 'In Progress')
            ORDER BY due_date;
        `);

    const [rows, history, contracts, tasks] = result.recordsets as sql.IRecordSet<any>[];
    if (rows.length === 0) return null;
    return { ...rows[0], history, contracts, open_tasks: tasks };
};

// Raw row (not deleted) - for ownership checks before changes
export const getProcurementRowService = async (procurementId: number): Promise<ProcurementRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, procurementId)
        .query(`SELECT ${ROW_COLUMNS} FROM dbo.Procurements WHERE procurement_id = @id AND is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// ------------------------------- Commands ------------------------------------

// Binds every editable column of a procurement onto a request
const bindProcurementFields = (request: sql.Request, p: Omit<ProcurementRow, 'procurement_id' | 'current_stage_id' | 'stage_entered_at'>) =>
    request
        .input('reference', sql.NVarChar(30), p.reference)
        .input('title', sql.NVarChar(500), p.title)
        .input('budget_line_id', sql.Int, p.budget_line_id)
        .input('fy_id', sql.Int, p.fy_id)
        .input('owner_id', sql.Int, p.owner_id)
        .input('category_id', sql.Int, p.category_id)
        .input('priority_id', sql.Int, p.priority_id)
        .input('acquisition_method_id', sql.Int, p.acquisition_method_id)
        .input('scm_officer_id', sql.Int, p.scm_officer_id)
        .input('status', sql.NVarChar(20), p.status)
        .input('tender_float_date', sql.Date, p.tender_float_date)
        .input('tender_opening_date', sql.Date, p.tender_opening_date)
        .input('is_escalated', sql.Bit, p.is_escalated)
        .input('escalated_to', sql.NVarChar(150), p.escalated_to)
        .input('escalation_note', sql.NVarChar(1000), p.escalation_note)
        .input('notes', sql.NVarChar(sql.MAX), p.notes);

// Create a procurement
export const createProcurementService = async (
    input: Omit<CreateProcurementInput, 'owner_id'> & { owner_id: number },
    actorId: number,
): Promise<number> => {
    return withTransaction(async (tx) => {
        const request = bindProcurementFields(new sql.Request(tx), {
            reference: input.reference,
            title: input.title,
            budget_line_id: input.budget_line_id ?? null,
            fy_id: input.fy_id,
            owner_id: input.owner_id,
            category_id: input.category_id,
            priority_id: input.priority_id ?? null,
            acquisition_method_id: input.acquisition_method_id ?? null,
            scm_officer_id: input.scm_officer_id ?? null,
            status: input.status,
            tender_float_date: input.tender_float_date ?? null,
            tender_opening_date: input.tender_opening_date ?? null,
            is_escalated: input.is_escalated,
            escalated_to: input.escalated_to,
            escalation_note: input.escalation_note,
            notes: input.notes,
        });

        const result = await request
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Procurements
                        (reference, title, budget_line_id, fy_id, owner_id, category_id, priority_id, acquisition_method_id,
                         scm_officer_id, status, tender_float_date, tender_opening_date, is_escalated, escalated_to,
                         escalation_note, notes, created_by)
                    OUTPUT INSERTED.procurement_id
                    VALUES (@reference, @title, @budget_line_id, @fy_id, @owner_id, @category_id, @priority_id, @acquisition_method_id,
                            @scm_officer_id, @status, @tender_float_date, @tender_opening_date, @is_escalated, @escalated_to,
                            @escalation_note, @notes, @created_by)`);

        const procurementId: number = result.recordset[0].procurement_id;
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Procurements', entityId: procurementId, newValues: input });
        return procurementId;
    });
};

// Update a procurement. Only fields present in `input` change.
export const updateProcurementService = async (before: ProcurementRow, input: UpdateProcurementInput, actorId: number): Promise<void> => {
    // Merge: undefined = keep current value, null = clear it
    const pick = <K extends keyof UpdateProcurementInput & keyof ProcurementRow>(key: K) =>
        (input[key] === undefined ? before[key] : input[key]) as ProcurementRow[K];

    const merged = {
        reference: pick('reference'),
        title: pick('title'),
        budget_line_id: pick('budget_line_id'),
        fy_id: pick('fy_id'),
        owner_id: pick('owner_id'),
        category_id: pick('category_id'),
        priority_id: pick('priority_id'),
        acquisition_method_id: pick('acquisition_method_id'),
        scm_officer_id: pick('scm_officer_id'),
        status: pick('status'),
        tender_float_date: pick('tender_float_date'),
        tender_opening_date: pick('tender_opening_date'),
        is_escalated: pick('is_escalated'),
        escalated_to: pick('escalated_to'),
        escalation_note: pick('escalation_note'),
        notes: pick('notes'),
    };

    if (merged.tender_float_date && merged.tender_opening_date && merged.tender_opening_date < merged.tender_float_date) {
        throw new HttpError(400, 'tender_opening_date cannot be before tender_float_date');
    }

    // Clearing the escalation flag also clears who it was escalated to
    if (!merged.is_escalated) {
        merged.escalated_to = null;
        merged.escalation_note = null;
    }

    await withTransaction(async (tx) => {
        const result = await bindProcurementFields(new sql.Request(tx), merged)
            .input('id', sql.Int, before.procurement_id)
            .query(`UPDATE dbo.Procurements
                    SET reference = @reference, title = @title, budget_line_id = @budget_line_id, fy_id = @fy_id,
                        owner_id = @owner_id, category_id = @category_id, priority_id = @priority_id,
                        acquisition_method_id = @acquisition_method_id, scm_officer_id = @scm_officer_id, status = @status,
                        tender_float_date = @tender_float_date, tender_opening_date = @tender_opening_date,
                        is_escalated = @is_escalated, escalated_to = @escalated_to, escalation_note = @escalation_note,
                        notes = @notes, updated_at = SYSUTCDATETIME()
                    WHERE procurement_id = @id;
                    SELECT ${ROW_COLUMNS} FROM dbo.Procurements WHERE procurement_id = @id;`);

        await writeAudit(tx, {
            userId: actorId, action: 'UPDATE', entity: 'Procurements', entityId: before.procurement_id,
            oldValues: before, newValues: result.recordset[0],
        });
    });
};

// Soft-delete a procurement (refused while it has active contracts)
export const deleteProcurementService = async (before: ProcurementRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        const contracts = await new sql.Request(tx)
            .input('id', sql.Int, before.procurement_id)
            .query(`SELECT COUNT(*) AS total FROM dbo.Contracts WHERE procurement_id = @id AND is_deleted = 0`);
        if (contracts.recordset[0].total > 0) {
            throw new HttpError(409, 'This procurement has contracts. Delete the contracts first.');
        }

        await new sql.Request(tx)
            .input('id', sql.Int, before.procurement_id)
            .query(`UPDATE dbo.Procurements SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE procurement_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Procurements', entityId: before.procurement_id, oldValues: before });
    });
};

// --------------------------- Stage tracking ----------------------------------

/**
 * Recalculates current_stage_id / stage_entered_at from the latest event and
 * nudges the overall status:
 *   Not Started -> In Progress once any step is recorded
 *   -> Completed when the final "Closed" step is approved/completed
 */
const recomputeCurrentStage = async (tx: sql.Transaction, procurementId: number): Promise<void> => {
    await new sql.Request(tx)
        .input('id', sql.Int, procurementId)
        .query(`
            DECLARE @stage_id INT, @event_status NVARCHAR(20), @event_date DATE, @sort_order INT, @stage_group NVARCHAR(30);

            -- Latest event: by date, then process order, then insertion order
            SELECT TOP 1 @stage_id = e.stage_id, @event_status = e.status, @event_date = e.event_date,
                         @sort_order = ws.sort_order, @stage_group = ws.stage_group
            FROM dbo.StageEvents e
            JOIN dbo.WorkflowStages ws ON ws.stage_id = e.stage_id
            WHERE e.procurement_id = @id
            ORDER BY e.event_date DESC, ws.sort_order DESC, e.event_id DESC;

            DECLARE @current_stage_id INT = @stage_id;

            -- A passed step moves the item on to the next active step (if any)
            IF @event_status IN ('Approved', 'Completed') AND @stage_group <> 'Closed'
            BEGIN
                SELECT TOP 1 @current_stage_id = stage_id
                FROM dbo.WorkflowStages
                WHERE is_active = 1 AND sort_order > @sort_order
                ORDER BY sort_order;
            END

            UPDATE dbo.Procurements
            SET current_stage_id = @current_stage_id,
                stage_entered_at = @event_date,
                status = CASE
                            WHEN @stage_group = 'Closed' AND @event_status IN ('Approved', 'Completed') THEN 'Completed'
                            WHEN status = 'Not Started' AND @stage_id IS NOT NULL THEN 'In Progress'
                            ELSE status
                         END,
                updated_at = SYSUTCDATETIME()
            WHERE procurement_id = @id;
        `);
};

// Record a step update (e.g. "eGP approval by HOD - Approved - 2026-09-07")
export const recordStageEventService = async (procurementId: number, input: RecordStageEventInput, actorId: number): Promise<number> => {
    return withTransaction(async (tx) => {
        const stage = await new sql.Request(tx)
            .input('stage_id', sql.Int, input.stage_id)
            .query(`SELECT stage_id FROM dbo.WorkflowStages WHERE stage_id = @stage_id AND is_active = 1`);
        if (stage.recordset.length === 0) {
            throw new HttpError(400, 'stage_id must be an active workflow stage');
        }

        const result = await new sql.Request(tx)
            .input('procurement_id', sql.Int, procurementId)
            .input('stage_id', sql.Int, input.stage_id)
            .input('status', sql.NVarChar(20), input.status)
            .input('event_date', sql.Date, input.event_date)
            .input('notes', sql.NVarChar(1000), input.notes)
            .input('recorded_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.StageEvents (procurement_id, stage_id, status, event_date, notes, recorded_by)
                    OUTPUT INSERTED.event_id
                    VALUES (@procurement_id, @stage_id, @status, @event_date, @notes, @recorded_by)`);

        const eventId: number = result.recordset[0].event_id;
        await recomputeCurrentStage(tx, procurementId);
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'StageEvents', entityId: eventId, newValues: { procurement_id: procurementId, ...input } });
        return eventId;
    });
};

// Remove a step update recorded by mistake. Returns false if it does not exist.
export const deleteStageEventService = async (procurementId: number, eventId: number, actorId: number): Promise<boolean> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('procurement_id', sql.Int, procurementId)
            .input('event_id', sql.Int, eventId)
            .query(`DELETE FROM dbo.StageEvents
                    OUTPUT DELETED.*
                    WHERE event_id = @event_id AND procurement_id = @procurement_id`);

        if (result.recordset.length === 0) return false;
        await recomputeCurrentStage(tx, procurementId);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'StageEvents', entityId: eventId, oldValues: result.recordset[0] });
        return true;
    });
};
