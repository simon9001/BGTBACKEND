import sql from 'mssql';
import { getDbPool } from '../db/dbconfig.js';

/**
 * Tracker service - everything needed to show the data the way the workbook's
 * sheets lay it out: sections (including empty ones), every budget line with its
 * yearly and quarterly plan, and every procurement with its status at each step.
 */

export const getTrackerService = async (fyId: number) => {
    const result = await getDbPool().request()
        .input('fy_id', sql.Int, fyId)
        .query(`
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

            SELECT a.budget_line_id, a.fy_id, a.planned_amount, a.q1_amount, a.q2_amount, a.q3_amount, a.q4_amount
            FROM dbo.BudgetAllocations a
            JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0;

            SELECT p.procurement_id, p.reference, p.title, p.section_id, p.budget_line_id, p.owner_id, p.owner_name,
                   p.category_id, p.category, p.priority_id, p.priority, p.status,
                   p.scm_officer_id, p.scm_officer, p.acquisition_method_id, p.acquisition_method, p.tender_float_date, p.tender_opening_date, p.tender_days,
                   p.is_escalated, p.escalated_to, p.escalation_note, p.progress_percent, p.notes
            FROM dbo.vw_Procurements p
            WHERE p.fy_id = @fy_id
            ORDER BY p.reference, p.procurement_id;

            -- Latest update of each step (the sheet has one cell per step)
            SELECT e.event_id, e.procurement_id, ws.code AS stage_code, e.status, e.event_date
            FROM (
                SELECT ev.event_id, ev.procurement_id, ev.stage_id, ev.status, ev.event_date,
                       ROW_NUMBER() OVER (PARTITION BY ev.procurement_id, ev.stage_id ORDER BY ev.event_date DESC, ev.event_id DESC) AS row_no
                FROM dbo.StageEvents ev
                JOIN dbo.Procurements p ON p.procurement_id = ev.procurement_id AND p.is_deleted = 0 AND p.fy_id = @fy_id
            ) e
            JOIN dbo.WorkflowStages ws ON ws.stage_id = e.stage_id
            WHERE e.row_no = 1;

            SELECT m.memo_id, m.reference, m.title, m.fy_id, m.owner_id, u.full_name AS owner_name,
                   m.category_id, cat.value AS category, m.priority_id, pr.value AS priority,
                   m.delivered_date, m.approved_date, m.dg_status, m.status, m.notes
            FROM dbo.Memos m
            JOIN dbo.Users u         ON u.user_id = m.owner_id
            JOIN dbo.Lookups cat     ON cat.lookup_id = m.category_id
            LEFT JOIN dbo.Lookups pr ON pr.lookup_id = m.priority_id
            WHERE m.is_deleted = 0 AND m.fy_id = @fy_id
            ORDER BY m.reference, m.memo_id;

            SELECT t.task_id, t.title, t.description, t.procurement_id, t.section_id, t.owner_id, u.full_name AS owner_name, t.priority_id, pr.value AS priority, t.due_date, t.status, t.created_at
            FROM dbo.Tasks t
            JOIN dbo.Users u         ON u.user_id = t.owner_id
            LEFT JOIN dbo.Lookups pr ON pr.lookup_id = t.priority_id
            WHERE t.is_deleted = 0
            ORDER BY t.task_id;
        `);

    const [sections, stages, years, lines, allocations, procurements, events, memos, tasks] = result.recordsets as sql.IRecordSet<any>[];

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
                .map(({ budget_line_id: _line, ...a }) => ({
                    fy_id: a.fy_id,
                    planned_amount: Number(a.planned_amount),
                    q1_amount: Number(a.q1_amount),
                    q2_amount: Number(a.q2_amount),
                    q3_amount: Number(a.q3_amount),
                    q4_amount: Number(a.q4_amount),
                })),
        })),
        procurements: procurements.map((p) => ({
            ...p,
            steps: Object.fromEntries(events
                .filter((e) => e.procurement_id === p.procurement_id)
                .map((e) => [e.stage_code, { event_id: e.event_id, status: e.status, event_date: e.event_date }])),
        })),
        memos,
        tasks,
    };
};
