import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { toOffset } from '../utils/pagination.js';
import type { CreateTaskInput, TaskQuery, UpdateTaskInput } from '../validators/task.validators.js';

/**
 * Tasks service - follow-up items (e.g. "Follow up on invoice payment"),
 * optionally linked to a procurement.
 */

/** Raw row from dbo.Tasks. */
export interface TaskRow {
    task_id: number;
    title: string;
    description: string | null;
    owner_id: number;
    procurement_id: number | null;
    priority_id: number | null;
    due_date: string | null;
    status: string;
}

const ROW_COLUMNS = `task_id, title, description, owner_id, procurement_id, priority_id,
    CONVERT(CHAR(10), due_date, 23) AS due_date, status`;

// A task is overdue when it is still open and its due date has passed
const IS_OVERDUE = `CASE WHEN t.status IN ('Open', 'In Progress') AND t.due_date < CAST(SYSDATETIME() AS DATE) THEN 1 ELSE 0 END`;

// Paginated, filterable list of tasks (soonest due first)
export const listTasksService = async (query: TaskQuery, currentUserId: number) => {
    const db = getDbPool();
    const from = `
        FROM dbo.Tasks t
        JOIN dbo.Users u             ON u.user_id = t.owner_id
        LEFT JOIN dbo.Procurements p ON p.procurement_id = t.procurement_id
        LEFT JOIN dbo.Lookups pr     ON pr.lookup_id = t.priority_id
        WHERE t.is_deleted = 0
          AND (@owner_id IS NULL OR t.owner_id = @owner_id)
          AND (@procurement_id IS NULL OR t.procurement_id = @procurement_id)
          AND (@status IS NULL OR t.status = @status)
          AND (@open_only IS NULL OR @open_only = 0 OR t.status IN ('Open', 'In Progress'))
          AND (@overdue IS NULL OR ${IS_OVERDUE} = @overdue)`;

    const result = await db.request()
        .input('owner_id', sql.Int, query.mine ? currentUserId : (query.owner_id ?? null))
        .input('procurement_id', sql.Int, query.procurement_id ?? null)
        .input('status', sql.NVarChar(20), query.status ?? null)
        .input('open_only', sql.Bit, query.open_only ?? null)
        .input('overdue', sql.Bit, query.overdue ?? null)
        .input('offset', sql.Int, toOffset(query.page, query.limit))
        .input('limit', sql.Int, query.limit)
        .query(`
            SELECT COUNT(*) AS total ${from};

            SELECT t.task_id, t.title, t.description, t.owner_id, u.full_name AS owner_name,
                   t.procurement_id, p.title AS procurement_title, t.priority_id, pr.value AS priority,
                   t.due_date, t.status, CAST(${IS_OVERDUE} AS BIT) AS is_overdue, t.created_at, t.updated_at
            ${from}
            ORDER BY CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.task_id DESC
            OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;
        `);

    const recordsets = result.recordsets as sql.IRecordSet<any>[];
    return { total: recordsets[0][0].total as number, rows: recordsets[1] };
};

// Raw row (not deleted)
export const getTaskRowService = async (taskId: number): Promise<TaskRow | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('id', sql.Int, taskId)
        .query(`SELECT ${ROW_COLUMNS} FROM dbo.Tasks WHERE task_id = @id AND is_deleted = 0`);
    return result.recordset[0] ?? null;
};

// Create a task
export const createTaskService = async (input: Omit<CreateTaskInput, 'owner_id'> & { owner_id: number }, actorId: number): Promise<TaskRow> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('title', sql.NVarChar(300), input.title)
            .input('description', sql.NVarChar(sql.MAX), input.description)
            .input('owner_id', sql.Int, input.owner_id)
            .input('procurement_id', sql.Int, input.procurement_id ?? null)
            .input('priority_id', sql.Int, input.priority_id ?? null)
            .input('due_date', sql.Date, input.due_date ?? null)
            .input('status', sql.NVarChar(20), input.status)
            .input('created_by', sql.Int, actorId)
            .query(`INSERT INTO dbo.Tasks (title, description, owner_id, procurement_id, priority_id, due_date, status, created_by)
                    OUTPUT INSERTED.task_id
                    VALUES (@title, @description, @owner_id, @procurement_id, @priority_id, @due_date, @status, @created_by);`);

        const taskId: number = result.recordset[0].task_id;
        const task = (await new sql.Request(tx)
            .input('id', sql.Int, taskId)
            .query(`SELECT ${ROW_COLUMNS} FROM dbo.Tasks WHERE task_id = @id`)).recordset[0] as TaskRow;

        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Tasks', entityId: taskId, newValues: task });
        return task;
    });
};

// Update a task. Only fields present in `input` change.
export const updateTaskService = async (before: TaskRow, input: UpdateTaskInput, actorId: number): Promise<TaskRow> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('id', sql.Int, before.task_id)
            .input('title', sql.NVarChar(300), input.title ?? before.title)
            .input('description', sql.NVarChar(sql.MAX), input.description === undefined ? before.description : input.description)
            .input('owner_id', sql.Int, input.owner_id ?? before.owner_id)
            .input('procurement_id', sql.Int, input.procurement_id === undefined ? before.procurement_id : input.procurement_id)
            .input('priority_id', sql.Int, input.priority_id === undefined ? before.priority_id : input.priority_id)
            .input('due_date', sql.Date, input.due_date === undefined ? before.due_date : input.due_date)
            .input('status', sql.NVarChar(20), input.status ?? before.status)
            .query(`UPDATE dbo.Tasks
                    SET title = @title, description = @description, owner_id = @owner_id, procurement_id = @procurement_id,
                        priority_id = @priority_id, due_date = @due_date, status = @status, updated_at = SYSUTCDATETIME()
                    WHERE task_id = @id;
                    SELECT ${ROW_COLUMNS} FROM dbo.Tasks WHERE task_id = @id;`);

        const after: TaskRow = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Tasks', entityId: before.task_id, oldValues: before, newValues: after });
        return after;
    });
};

// Soft-delete a task
export const deleteTaskService = async (before: TaskRow, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        await new sql.Request(tx)
            .input('id', sql.Int, before.task_id)
            .query(`UPDATE dbo.Tasks SET is_deleted = 1, updated_at = SYSUTCDATETIME() WHERE task_id = @id`);
        await writeAudit(tx, { userId: actorId, action: 'DELETE', entity: 'Tasks', entityId: before.task_id, oldValues: before });
    });
};
