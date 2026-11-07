import sql from 'mssql';
import { getDbPool } from '../db/dbconfig.js';

/**
 * Tracker service - everything needed to show the data the way the workbook's
 * sheets lay it out: sections (including empty ones), every budget line with its
 * yearly and quarterly plan, and every procurement with its status at each step.
 */

// A procurement belongs to the year viewed, or tracks a budget line planned in it,
// so a multi-year line keeps its one process row in every year of its plan
const shownInYear = (alias: string) => `(${alias}.fy_id = @fy_id OR ${alias}.budget_line_id IN (
    SELECT budget_line_id FROM dbo.BudgetAllocations WHERE fy_id = @fy_id))`;

export const getTrackerService = async (fyId: number) => {
    const result = await getDbPool().request()
        .input('fy_id', sql.Int, fyId)
        .query(`
            DECLARE @start DATE, @end DATE;
            SELECT @start = start_date, @end = end_date FROM dbo.FinancialYears WHERE fy_id = @fy_id;

            SELECT lookup_id AS section_id, value AS name, sort_order
            FROM dbo.Lookups WHERE lookup_type = 'section' AND is_active = 1 ORDER BY sort_order;

            SELECT stage_id, code, name, stage_group, sort_order
            FROM dbo.WorkflowStages WHERE is_active = 1 ORDER BY sort_order;

            SELECT fy_id, code, CONVERT(CHAR(10), start_date, 23) AS start_date FROM dbo.FinancialYears ORDER BY start_date;

            SELECT bl.budget_line_id, bl.code, bl.description, bl.section_id, bl.category_id, cat.value AS category,
                   bl.priority_id, pr.value AS priority, bl.quantity, bl.unit_price, bl.total_amount,
                   bl.owner_id, u.full_name AS owner_name
            FROM dbo.BudgetLines bl
            JOIN dbo.Lookups cat     ON cat.lookup_id = bl.category_id
            LEFT JOIN dbo.Lookups pr ON pr.lookup_id = bl.priority_id
            JOIN dbo.Users u         ON u.user_id = bl.owner_id
            WHERE bl.is_deleted = 0
            ORDER BY bl.code, bl.budget_line_id;

            SELECT a.budget_line_id, a.fy_id, a.planned_amount
            FROM dbo.BudgetAllocations a
            JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0;

            -- Expenditure Q1-Q4: what was actually paid
            SELECT budget_line_id, fy_id, q1_actual, q2_actual, q3_actual, q4_actual FROM dbo.vw_BudgetLineActuals;

            SELECT p.procurement_id, p.reference, p.title, p.fy_id, p.section_id, p.budget_line_id, p.owner_id, p.owner_name,
                   p.category_id, p.category, p.priority_id, p.priority, p.status,
                   p.scm_officer_id, p.scm_officer, p.acquisition_method_id, p.acquisition_method, p.tender_float_date, p.tender_opening_date, p.tender_days,
                   p.is_escalated, p.escalated_to, p.escalation_note, p.progress_percent, p.notes
            FROM dbo.vw_Procurements p
            WHERE ${shownInYear('p')}
            ORDER BY p.reference, p.procurement_id;

            -- Latest update of each step (the sheet has one cell per step)
            SELECT e.event_id, e.procurement_id, ws.code AS stage_code, e.status, e.event_date, e.date_known
            FROM (
                SELECT ev.event_id, ev.procurement_id, ev.stage_id, ev.status, ev.event_date, ev.date_known,
                       ROW_NUMBER() OVER (PARTITION BY ev.procurement_id, ev.stage_id ORDER BY ev.event_date DESC, ev.event_id DESC) AS row_no
                FROM dbo.StageEvents ev
                JOIN dbo.Procurements p ON p.procurement_id = ev.procurement_id AND p.is_deleted = 0 AND ${shownInYear('p')}
            ) e
            JOIN dbo.WorkflowStages ws ON ws.stage_id = e.stage_id
            WHERE e.row_no = 1;

            SELECT m.memo_id, m.reference, m.title, m.fy_id, m.owner_id, u.full_name AS owner_name,
                   m.category_id, cat.value AS category, m.priority_id, pr.value AS priority,
                   m.delivered_date, m.approved_date, m.dg_status, m.status, m.notes, m.is_escalated, m.escalated_to
            FROM dbo.Memos m
            JOIN dbo.Users u         ON u.user_id = m.owner_id
            JOIN dbo.Lookups cat     ON cat.lookup_id = m.category_id
            LEFT JOIN dbo.Lookups pr ON pr.lookup_id = m.priority_id
            WHERE m.is_deleted = 0 AND m.fy_id = @fy_id
            ORDER BY m.reference, m.memo_id;

            -- A task belongs to the year it is due in or, with no due date, was created in
            SELECT t.task_id, t.title, t.description, t.procurement_id, t.section_id, t.owner_id, u.full_name AS owner_name, t.priority_id, pr.value AS priority,
                   t.category_id, cat.value AS category, t.due_date, t.status, t.is_escalated, t.escalated_to, t.created_at
            FROM dbo.Tasks t
            JOIN dbo.Users u          ON u.user_id = t.owner_id
            LEFT JOIN dbo.Lookups pr  ON pr.lookup_id = t.priority_id
            LEFT JOIN dbo.Lookups cat ON cat.lookup_id = t.category_id
            WHERE t.is_deleted = 0 AND COALESCE(t.due_date, CAST(t.created_at AS DATE)) BETWEEN @start AND @end
            ORDER BY t.task_id;
        `);

    const [sections, stages, years, lines, allocations, actuals, procurements, events, memos, tasks] = result.recordsets as sql.IRecordSet<any>[];

    return {
        sections,
        stages,
        financial_years: years,
        budget_lines: lines.map((line) => ({
            ...line,
            unit_price: Number(line.unit_price),
            total_amount: Number(line.total_amount),
            allocations: allocations
                .filter((a) => a.budget_line_id === line.budget_line_id)
                .map((a) => ({ fy_id: a.fy_id, planned_amount: Number(a.planned_amount) })),
            actuals: actuals
                .filter((a) => a.budget_line_id === line.budget_line_id)
                .map((a) => ({
                    fy_id: a.fy_id,
                    q1_actual: Number(a.q1_actual),
                    q2_actual: Number(a.q2_actual),
                    q3_actual: Number(a.q3_actual),
                    q4_actual: Number(a.q4_actual),
                })),
        })),
        procurements: procurements.map((p) => ({
            ...p,
            steps: Object.fromEntries(events
                .filter((e) => e.procurement_id === p.procurement_id)
                .map((e) => [e.stage_code, { event_id: e.event_id, status: e.status, event_date: e.event_date, date_known: e.date_known }])),
        })),
        memos,
        tasks,
    };
};
