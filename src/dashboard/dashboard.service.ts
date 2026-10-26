import sql from 'mssql';
import { getDbPool } from '../db/dbconfig.js';
import type { DashboardFilters } from '../validators/dashboard.validators.js';

/**
 * Dashboard service - read-only aggregate queries that feed the charts.
 *
 * Definitions used throughout:
 *   budget      = planned allocations for the financial year
 *   contracted  = value of contracts awarded for the year's procurements
 *   invoiced    = non-rejected invoices received within the year
 *   paid        = payments made within the year (actual expenditure)
 *   outstanding = approved/unpaid invoice balances right now
 * Kenyan FY quarters: Q1 Jul-Sep, Q2 Oct-Dec, Q3 Jan-Mar, Q4 Apr-Jun.
 */

// ------------------------------- Helpers -------------------------------------

// Creates a request with the standard filter parameters bound
const filteredRequest = (filters: DashboardFilters) =>
    getDbPool().request()
        .input('fy_id', sql.Int, filters.fy_id)
        .input('category_id', sql.Int, filters.category_id ?? null)
        .input('owner_id', sql.Int, filters.owner_id ?? null);

// Declares @start / @end as the selected financial year's dates
const DECLARE_FY_DATES = `
    DECLARE @start DATE, @end DATE;
    SELECT @start = start_date, @end = end_date FROM dbo.FinancialYears WHERE fy_id = @fy_id;`;

// Category / owner filter for a table aliased as `alias`
const categoryOwnerFilter = (alias: string) =>
    `(@category_id IS NULL OR ${alias}.category_id = @category_id) AND (@owner_id IS NULL OR ${alias}.owner_id = @owner_id)`;

// Payments joined back to their procurement (for category / owner filters)
const PAYMENTS_WITH_PROCUREMENT = `
    FROM dbo.Payments pay
    JOIN dbo.Invoices i     ON i.invoice_id = pay.invoice_id AND i.is_deleted = 0
    JOIN dbo.Contracts c    ON c.contract_id = i.contract_id AND c.is_deleted = 0
    JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
    WHERE pay.is_deleted = 0`;

// SQL expression: Kenyan FY quarter (1-4) of a date column
const fiscalQuarter = (column: string) => `((MONTH(${column}) + 5) % 12) / 3 + 1`;

// ------------------------------- Queries -------------------------------------

/** KPI tiles: money figures and procurement counts for the year. */
export const getSummaryService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        ${DECLARE_FY_DATES}

        SELECT
            (SELECT ISNULL(SUM(a.planned_amount), 0)
             FROM dbo.BudgetAllocations a
             JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0
             WHERE a.fy_id = @fy_id AND ${categoryOwnerFilter('bl')}) AS budget,

            (SELECT ISNULL(SUM(c.contract_value), 0)
             FROM dbo.Contracts c
             JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
             WHERE c.is_deleted = 0 AND c.status <> 'Terminated' AND p.fy_id = @fy_id AND ${categoryOwnerFilter('p')}) AS contracted,

            (SELECT ISNULL(SUM(i.amount), 0)
             FROM dbo.Invoices i
             JOIN dbo.Contracts c    ON c.contract_id = i.contract_id AND c.is_deleted = 0
             JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
             WHERE i.is_deleted = 0 AND i.status <> 'Rejected'
               AND i.received_date BETWEEN @start AND @end AND ${categoryOwnerFilter('p')}) AS invoiced,

            (SELECT ISNULL(SUM(pay.amount), 0) ${PAYMENTS_WITH_PROCUREMENT}
               AND pay.payment_date BETWEEN @start AND @end AND ${categoryOwnerFilter('p')}) AS paid,

            (SELECT ISNULL(SUM(i.amount - ISNULL(paid.total, 0)), 0)
             FROM dbo.Invoices i
             JOIN dbo.Contracts c    ON c.contract_id = i.contract_id AND c.is_deleted = 0
             JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
             OUTER APPLY (SELECT SUM(amount) AS total FROM dbo.Payments WHERE invoice_id = i.invoice_id AND is_deleted = 0) paid
             WHERE i.is_deleted = 0 AND i.status NOT IN ('Paid', 'Rejected') AND ${categoryOwnerFilter('p')}) AS outstanding,

            (SELECT COUNT(*)
             FROM dbo.Invoices i
             JOIN dbo.Contracts c    ON c.contract_id = i.contract_id AND c.is_deleted = 0
             JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
             WHERE i.is_deleted = 0 AND i.status NOT IN ('Paid', 'Rejected') AND ${categoryOwnerFilter('p')}) AS unpaid_invoices;

        SELECT
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'Not Started' THEN 1 ELSE 0 END) AS not_started,
            SUM(CASE WHEN status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN status = 'On Hold'     THEN 1 ELSE 0 END) AS on_hold,
            SUM(CASE WHEN status = 'Completed'   THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status IN ('Cancelled', 'Rejected') THEN 1 ELSE 0 END) AS cancelled_or_rejected,
            SUM(CASE WHEN is_overdue = 1 THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN is_escalated = 1 AND status NOT IN ('Completed', 'Cancelled', 'Rejected') THEN 1 ELSE 0 END) AS escalated
        FROM dbo.vw_Procurements p
        WHERE p.fy_id = @fy_id AND ${categoryOwnerFilter('p')};
    `);

    const [moneyRows, countRows] = result.recordsets as sql.IRecordSet<any>[];
    const money = moneyRows[0];
    const counts = countRows[0];

    // SUM over zero rows is NULL - normalise counts to numbers
    const procurements = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value ?? 0)]));

    return {
        budget: Number(money.budget),
        contracted: Number(money.contracted),
        invoiced: Number(money.invoiced),
        paid: Number(money.paid),
        outstanding: Number(money.outstanding),
        unpaid_invoices: Number(money.unpaid_invoices),
        budget_utilisation_percent: money.budget > 0 ? round1((money.paid / money.budget) * 100) : 0,
        completion_rate_percent: procurements.total > 0 ? round1((procurements.completed / procurements.total) * 100) : 0,
        procurements,
    };
};

/** Budget vs contracted vs paid, one row per category. */
export const getBudgetByCategoryService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        ${DECLARE_FY_DATES}

        SELECT cat.lookup_id AS category_id, cat.value AS category,
            ISNULL((SELECT SUM(a.planned_amount)
                    FROM dbo.BudgetAllocations a
                    JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0
                    WHERE a.fy_id = @fy_id AND bl.category_id = cat.lookup_id
                      AND (@owner_id IS NULL OR bl.owner_id = @owner_id)), 0) AS budget,
            ISNULL((SELECT SUM(c.contract_value)
                    FROM dbo.Contracts c
                    JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
                    WHERE c.is_deleted = 0 AND c.status <> 'Terminated' AND p.fy_id = @fy_id AND p.category_id = cat.lookup_id
                      AND (@owner_id IS NULL OR p.owner_id = @owner_id)), 0) AS contracted,
            ISNULL((SELECT SUM(pay.amount) ${PAYMENTS_WITH_PROCUREMENT}
                      AND pay.payment_date BETWEEN @start AND @end AND p.category_id = cat.lookup_id
                      AND (@owner_id IS NULL OR p.owner_id = @owner_id)), 0) AS paid
        FROM dbo.Lookups cat
        WHERE cat.lookup_type = 'category'
          AND (@category_id IS NULL OR cat.lookup_id = @category_id)
        ORDER BY cat.sort_order;
    `);

    // Hide categories with no activity at all this year
    return result.recordset
        .map((row) => ({ ...row, budget: Number(row.budget), contracted: Number(row.contracted), paid: Number(row.paid) }))
        .filter((row) => row.budget > 0 || row.contracted > 0 || row.paid > 0);
};

/** Planned vs actual spend per quarter, with running totals. */
export const getQuarterlySpendService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        ${DECLARE_FY_DATES}

        SELECT
            ISNULL(SUM(a.q1_amount), 0) AS q1, ISNULL(SUM(a.q2_amount), 0) AS q2,
            ISNULL(SUM(a.q3_amount), 0) AS q3, ISNULL(SUM(a.q4_amount), 0) AS q4
        FROM dbo.BudgetAllocations a
        JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0
        WHERE a.fy_id = @fy_id AND ${categoryOwnerFilter('bl')};

        SELECT ${fiscalQuarter('pay.payment_date')} AS quarter, SUM(pay.amount) AS actual
        ${PAYMENTS_WITH_PROCUREMENT}
          AND pay.payment_date BETWEEN @start AND @end AND ${categoryOwnerFilter('p')}
        GROUP BY ${fiscalQuarter('pay.payment_date')};
    `);

    const [plannedRows, actualRows] = result.recordsets as sql.IRecordSet<any>[];
    const planned = plannedRows[0];
    const actualByQuarter = new Map<number, number>(actualRows.map((row) => [row.quarter, Number(row.actual)]));

    let cumulativePlanned = 0;
    let cumulativeActual = 0;
    return [1, 2, 3, 4].map((quarter) => {
        const plannedAmount = Number(planned[`q${quarter}`]);
        const actualAmount = actualByQuarter.get(quarter) ?? 0;
        cumulativePlanned += plannedAmount;
        cumulativeActual += actualAmount;
        return {
            quarter: `Q${quarter}`,
            planned: plannedAmount,
            actual: actualAmount,
            cumulative_planned: cumulativePlanned,
            cumulative_actual: cumulativeActual,
        };
    });
};

/** How many open procurements sit at each workflow step right now. */
export const getPipelineService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        WITH open_items AS (
            SELECT p.current_stage_id, p.is_overdue
            FROM dbo.vw_Procurements p
            WHERE p.fy_id = @fy_id AND p.status IN ('Not Started', 'In Progress', 'On Hold')
              AND ${categoryOwnerFilter('p')}
        )
        SELECT NULL AS stage_id, 'NOT_STARTED' AS stage_code, 'Not started yet' AS stage_name, 'Memo' AS stage_group, 0 AS sort_order,
               COUNT(*) AS items, SUM(CAST(is_overdue AS INT)) AS overdue
        FROM open_items WHERE current_stage_id IS NULL
        UNION ALL
        SELECT ws.stage_id, ws.code, ws.name, ws.stage_group, ws.sort_order,
               COUNT(o.current_stage_id), ISNULL(SUM(CAST(o.is_overdue AS INT)), 0)
        FROM dbo.WorkflowStages ws
        LEFT JOIN open_items o ON o.current_stage_id = ws.stage_id
        WHERE ws.is_active = 1
        GROUP BY ws.stage_id, ws.code, ws.name, ws.stage_group, ws.sort_order
        ORDER BY sort_order;
    `);
    return result.recordset.map((row) => ({ ...row, overdue: Number(row.overdue ?? 0) }));
};

/**
 * Average days each step takes vs its SLA target.
 * A step's duration = date it was passed (Approved/Completed) minus the date
 * the previous step was passed, for the same procurement.
 */
export const getStageDurationsService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        WITH passed AS (
            -- first time each procurement passed each step
            SELECT e.procurement_id, e.stage_id, MIN(e.event_date) AS passed_on
            FROM dbo.StageEvents e
            JOIN dbo.Procurements p ON p.procurement_id = e.procurement_id AND p.is_deleted = 0
            WHERE e.status IN ('Approved', 'Completed') AND p.fy_id = @fy_id AND ${categoryOwnerFilter('p')}
            GROUP BY e.procurement_id, e.stage_id
        ),
        durations AS (
            SELECT ps.stage_id,
                   DATEDIFF(DAY,
                            LAG(ps.passed_on) OVER (PARTITION BY ps.procurement_id ORDER BY ws.sort_order),
                            ps.passed_on) AS days
            FROM passed ps
            JOIN dbo.WorkflowStages ws ON ws.stage_id = ps.stage_id
        )
        SELECT ws.stage_id, ws.code AS stage_code, ws.name AS stage_name, ws.stage_group, ws.sla_days,
               COUNT(d.days) AS samples,
               AVG(CAST(d.days AS DECIMAL(10,1))) AS avg_days,
               MAX(d.days) AS max_days
        FROM dbo.WorkflowStages ws
        LEFT JOIN durations d ON d.stage_id = ws.stage_id AND d.days IS NOT NULL AND d.days >= 0
        WHERE ws.is_active = 1
        GROUP BY ws.stage_id, ws.code, ws.name, ws.stage_group, ws.sla_days, ws.sort_order
        ORDER BY ws.sort_order;
    `);
    return result.recordset.map((row) => ({
        ...row,
        avg_days: row.avg_days === null ? null : Number(row.avg_days),
        over_sla: row.avg_days !== null && Number(row.avg_days) > row.sla_days,
    }));
};

/** Procurement status counts and open tasks per officer. */
export const getOfficerWorkloadService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        SELECT u.user_id, u.full_name,
            SUM(CASE WHEN p.status = 'Not Started' THEN 1 ELSE 0 END) AS not_started,
            SUM(CASE WHEN p.status = 'In Progress' THEN 1 ELSE 0 END) AS in_progress,
            SUM(CASE WHEN p.status = 'On Hold'     THEN 1 ELSE 0 END) AS on_hold,
            SUM(CASE WHEN p.status = 'Completed'   THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN p.is_overdue = 1 THEN 1 ELSE 0 END) AS overdue,
            SUM(CASE WHEN p.is_escalated = 1 AND p.status NOT IN ('Completed', 'Cancelled', 'Rejected') THEN 1 ELSE 0 END) AS escalated,
            (SELECT COUNT(*) FROM dbo.Tasks t
             WHERE t.owner_id = u.user_id AND t.is_deleted = 0 AND t.status IN ('Open', 'In Progress')) AS open_tasks
        FROM dbo.Users u
        LEFT JOIN dbo.vw_Procurements p
               ON p.owner_id = u.user_id AND p.fy_id = @fy_id
              AND (@category_id IS NULL OR p.category_id = @category_id)
        WHERE u.is_active = 1 AND u.role IN ('admin', 'officer')
          AND (@owner_id IS NULL OR u.user_id = @owner_id)
        GROUP BY u.user_id, u.full_name
        ORDER BY u.full_name;
    `);
    return result.recordset;
};

/** Outstanding invoices grouped by how long they have been waiting. */
export const getInvoiceAgeingService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        WITH outstanding AS (
            SELECT DATEDIFF(DAY, i.received_date, CAST(SYSDATETIME() AS DATE)) AS age_days,
                   i.amount - ISNULL(paid.total, 0) AS balance
            FROM dbo.Invoices i
            JOIN dbo.Contracts c    ON c.contract_id = i.contract_id AND c.is_deleted = 0
            JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
            OUTER APPLY (SELECT SUM(amount) AS total FROM dbo.Payments WHERE invoice_id = i.invoice_id AND is_deleted = 0) paid
            WHERE i.is_deleted = 0 AND i.status NOT IN ('Paid', 'Rejected') AND ${categoryOwnerFilter('p')}
        ),
        buckets AS (
            SELECT bucket, sort_order, min_days, max_days FROM (VALUES
                ('0-30 days', 1, 0, 30), ('31-60 days', 2, 31, 60), ('61-90 days', 3, 61, 90), ('Over 90 days', 4, 91, 100000)
            ) AS b (bucket, sort_order, min_days, max_days)
        )
        SELECT b.bucket, COUNT(o.age_days) AS invoices, ISNULL(SUM(o.balance), 0) AS amount
        FROM buckets b
        LEFT JOIN outstanding o ON o.age_days BETWEEN b.min_days AND b.max_days
        GROUP BY b.bucket, b.sort_order
        ORDER BY b.sort_order;
    `);
    return result.recordset.map((row) => ({ ...row, amount: Number(row.amount) }));
};

/** Active contracts ending within `days` (or already past their end date). */
export const getExpiringContractsService = async (filters: DashboardFilters, days: number) => {
    const result = await filteredRequest(filters)
        .input('days', sql.Int, days)
        .query(`
            SELECT c.contract_id, c.contract_number, c.supplier_name, c.contract_value, c.start_date, c.end_date,
                   DATEDIFF(DAY, CAST(SYSDATETIME() AS DATE), c.end_date) AS days_to_expiry,
                   p.procurement_id, p.title AS procurement_title, p.owner_id, u.full_name AS owner_name
            FROM dbo.Contracts c
            JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
            JOIN dbo.Users u        ON u.user_id = p.owner_id
            WHERE c.is_deleted = 0 AND c.status = 'Active'
              AND c.end_date <= DATEADD(DAY, @days, CAST(SYSDATETIME() AS DATE))
              AND ${categoryOwnerFilter('p')}
            ORDER BY c.end_date;
        `);
    return result.recordset;
};

/** Open procurements that are overdue or escalated - the "needs attention" table. */
export const getAttentionListService = async (filters: DashboardFilters) => {
    const result = await filteredRequest(filters).query(`
        SELECT TOP 50
            procurement_id, reference, title, owner_id, owner_name, category, priority, status,
            current_stage_name, days_in_stage, sla_days, is_overdue, is_escalated, escalated_to, escalation_note
        FROM dbo.vw_Procurements p
        WHERE p.fy_id = @fy_id
          AND p.status IN ('Not Started', 'In Progress', 'On Hold')
          AND (p.is_overdue = 1 OR p.is_escalated = 1)
          AND ${categoryOwnerFilter('p')}
        ORDER BY p.is_escalated DESC, p.priority_rank DESC, (p.days_in_stage - p.sla_days) DESC;
    `);
    return result.recordset;
};

/** Budget, contracted, paid and procurement counts for every financial year. */
export const getYearComparisonService = async (filters: Omit<DashboardFilters, 'fy_id'>) => {
    const result = await getDbPool().request()
        .input('category_id', sql.Int, filters.category_id ?? null)
        .input('owner_id', sql.Int, filters.owner_id ?? null)
        .query(`
            SELECT fy.fy_id, fy.code AS fy_code, fy.is_current,
                ISNULL((SELECT SUM(a.planned_amount)
                        FROM dbo.BudgetAllocations a
                        JOIN dbo.BudgetLines bl ON bl.budget_line_id = a.budget_line_id AND bl.is_deleted = 0
                        WHERE a.fy_id = fy.fy_id AND ${categoryOwnerFilter('bl')}), 0) AS budget,
                ISNULL((SELECT SUM(c.contract_value)
                        FROM dbo.Contracts c
                        JOIN dbo.Procurements p ON p.procurement_id = c.procurement_id AND p.is_deleted = 0
                        WHERE c.is_deleted = 0 AND c.status <> 'Terminated' AND p.fy_id = fy.fy_id AND ${categoryOwnerFilter('p')}), 0) AS contracted,
                ISNULL((SELECT SUM(pay.amount) ${PAYMENTS_WITH_PROCUREMENT}
                          AND pay.payment_date BETWEEN fy.start_date AND fy.end_date AND ${categoryOwnerFilter('p')}), 0) AS paid,
                (SELECT COUNT(*) FROM dbo.Procurements p
                 WHERE p.is_deleted = 0 AND p.fy_id = fy.fy_id AND ${categoryOwnerFilter('p')}) AS procurements,
                (SELECT COUNT(*) FROM dbo.Procurements p
                 WHERE p.is_deleted = 0 AND p.fy_id = fy.fy_id AND p.status = 'Completed' AND ${categoryOwnerFilter('p')}) AS completed
            FROM dbo.FinancialYears fy
            ORDER BY fy.start_date;
        `);
    return result.recordset.map((row) => ({
        ...row,
        budget: Number(row.budget),
        contracted: Number(row.contracted),
        paid: Number(row.paid),
    }));
};

// Rounds to one decimal place
const round1 = (value: number) => Math.round(value * 10) / 10;
