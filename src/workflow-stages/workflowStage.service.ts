import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import type { CreateStageInput, UpdateStageInput } from '../validators/settings.validators.js';

/**
 * Workflow stages service - the ordered procurement steps and their SLA targets.
 */

export interface WorkflowStage {
    stage_id: number;
    code: string;
    name: string;
    stage_group: string;
    sort_order: number;
    sla_days: number;
    is_active: boolean;
}

const COLUMNS = 'stage_id, code, name, stage_group, sort_order, sla_days, is_active';
const INSERTED_COLUMNS = COLUMNS.split(', ').map((col) => `INSERTED.${col}`).join(', ');

// All stages in process order
export const getStagesService = async (includeInactive: boolean): Promise<WorkflowStage[]> => {
    const db = getDbPool();
    const result = await db.request()
        .input('include_inactive', sql.Bit, includeInactive)
        .query(`SELECT ${COLUMNS} FROM dbo.WorkflowStages
                WHERE @include_inactive = 1 OR is_active = 1
                ORDER BY sort_order`);
    return result.recordset;
};

// One stage
export const getStageByIdService = async (stageId: number): Promise<WorkflowStage | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('stage_id', sql.Int, stageId)
        .query(`SELECT ${COLUMNS} FROM dbo.WorkflowStages WHERE stage_id = @stage_id`);
    return result.recordset[0] ?? null;
};

// Add a stage
export const createStageService = async (input: CreateStageInput, actorId: number): Promise<WorkflowStage> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('code', sql.NVarChar(30), input.code)
            .input('name', sql.NVarChar(150), input.name)
            .input('stage_group', sql.NVarChar(30), input.stage_group)
            .input('sort_order', sql.Int, input.sort_order)
            .input('sla_days', sql.Int, input.sla_days)
            .query(`INSERT INTO dbo.WorkflowStages (code, name, stage_group, sort_order, sla_days)
                    OUTPUT ${INSERTED_COLUMNS}
                    VALUES (@code, @name, @stage_group, @sort_order, @sla_days)`);

        const stage: WorkflowStage = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'WorkflowStages', entityId: stage.stage_id, newValues: stage });
        return stage;
    });
};

// Rename / regroup / reorder / change SLA / (de)activate a stage
export const updateStageService = async (stageId: number, input: UpdateStageInput, actorId: number): Promise<WorkflowStage | null> => {
    const before = await getStageByIdService(stageId);
    if (!before) return null;

    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('stage_id', sql.Int, stageId)
            .input('name', sql.NVarChar(150), input.name ?? before.name)
            .input('stage_group', sql.NVarChar(30), input.stage_group ?? before.stage_group)
            .input('sort_order', sql.Int, input.sort_order ?? before.sort_order)
            .input('sla_days', sql.Int, input.sla_days ?? before.sla_days)
            .input('is_active', sql.Bit, input.is_active ?? before.is_active)
            .query(`UPDATE dbo.WorkflowStages
                    SET name = @name, stage_group = @stage_group, sort_order = @sort_order,
                        sla_days = @sla_days, is_active = @is_active
                    OUTPUT ${INSERTED_COLUMNS}
                    WHERE stage_id = @stage_id`);

        const after: WorkflowStage = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'WorkflowStages', entityId: stageId, oldValues: before, newValues: after });
        return after;
    });
};
