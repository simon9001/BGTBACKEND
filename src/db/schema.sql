/* =============================================================================
   BGTtracker - ICT Department Budget & Procurement Tracker
   Database schema (Microsoft SQL Server)

   How to run:
     pnpm db:migrate        -> runs this file, then seed.sql
   The script is idempotent: every object is only created if it does not exist,
   so it is safe to run more than once.

   Design notes:
   - Financial year is DATA, not columns. A new year = a new row in FinancialYears.
   - Workflow steps (memo, eGP approvals, ToR, tender, ERP ...) are rows in
     WorkflowStages, and every update an officer records is a row in StageEvents.
     This gives full history and lets us measure how long each step takes.
   - Kenyan government FY runs July -> June:
       Q1 = Jul-Sep, Q2 = Oct-Dec, Q3 = Jan-Mar, Q4 = Apr-Jun
   - Nothing is hard-deleted from business tables (is_deleted flag), and every
     change is written to AuditLogs.
============================================================================= */

/* -----------------------------------------------------------------------------
   Users - ICT department staff who log in.
   role: admin   = Head of ICT (sees and edits everything, manages users/settings)
         officer = ICT officer (sees everything, edits only items they own)
         viewer  = read-only access to dashboards
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Users', 'U') IS NULL
CREATE TABLE dbo.Users (
    user_id        INT IDENTITY(1,1) PRIMARY KEY,
    full_name      NVARCHAR(150) NOT NULL,
    email          NVARCHAR(150) NOT NULL CONSTRAINT UQ_Users_email UNIQUE,
    phone_number   NVARCHAR(20)  NULL,
    password_hash  NVARCHAR(255) NOT NULL,
    role           NVARCHAR(20)  NOT NULL CONSTRAINT DF_Users_role DEFAULT 'officer'
                   CONSTRAINT CK_Users_role CHECK (role IN ('admin', 'officer', 'viewer')),
    is_active      BIT           NOT NULL CONSTRAINT DF_Users_is_active DEFAULT 1,
    last_login_at  DATETIME2     NULL,
    created_at     DATETIME2     NOT NULL CONSTRAINT DF_Users_created_at DEFAULT SYSUTCDATETIME(),
    updated_at     DATETIME2     NOT NULL CONSTRAINT DF_Users_updated_at DEFAULT SYSUTCDATETIME()
);
GO

/* -----------------------------------------------------------------------------
   Lookups - replaces the "Lists" sheet. The Head of ICT manages these values
   from the app (categories, priorities, acquisition methods, SCM officers ...).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Lookups', 'U') IS NULL
CREATE TABLE dbo.Lookups (
    lookup_id    INT IDENTITY(1,1) PRIMARY KEY,
    lookup_type  NVARCHAR(50)  NOT NULL
                 CONSTRAINT CK_Lookups_type CHECK (lookup_type IN ('category', 'priority', 'acquisition_method', 'scm_officer')),
    value        NVARCHAR(150) NOT NULL,
    sort_order   INT           NOT NULL CONSTRAINT DF_Lookups_sort_order DEFAULT 0,
    is_active    BIT           NOT NULL CONSTRAINT DF_Lookups_is_active DEFAULT 1,
    created_at   DATETIME2     NOT NULL CONSTRAINT DF_Lookups_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Lookups_type_value UNIQUE (lookup_type, value)
);
GO

/* -----------------------------------------------------------------------------
   FinancialYears - one row per FY, e.g. code '2026/27', 2026-07-01 -> 2027-06-30.
   Exactly one year should be flagged is_current (enforced by filtered index).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.FinancialYears', 'U') IS NULL
CREATE TABLE dbo.FinancialYears (
    fy_id       INT IDENTITY(1,1) PRIMARY KEY,
    code        NVARCHAR(9) NOT NULL CONSTRAINT UQ_FinancialYears_code UNIQUE,
    start_date  DATE        NOT NULL,
    end_date    DATE        NOT NULL,
    is_current  BIT         NOT NULL CONSTRAINT DF_FinancialYears_is_current DEFAULT 0,
    CONSTRAINT CK_FinancialYears_dates CHECK (end_date > start_date)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_FinancialYears_current')
CREATE UNIQUE INDEX UX_FinancialYears_current ON dbo.FinancialYears (is_current) WHERE is_current = 1;
GO

/* -----------------------------------------------------------------------------
   BudgetLines - what the department plans to buy (the 4 budget sheets merged:
   assets, maintenance & support, consultancy, subscriptions -> by category).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.BudgetLines', 'U') IS NULL
CREATE TABLE dbo.BudgetLines (
    budget_line_id  INT IDENTITY(1,1) PRIMARY KEY,
    code            NVARCHAR(20)   NULL,              -- e.g. M-001, C-002 (optional)
    description     NVARCHAR(500)  NOT NULL,
    category_id     INT            NOT NULL CONSTRAINT FK_BudgetLines_category REFERENCES dbo.Lookups(lookup_id),
    priority_id     INT            NULL     CONSTRAINT FK_BudgetLines_priority REFERENCES dbo.Lookups(lookup_id),
    owner_id        INT            NOT NULL CONSTRAINT FK_BudgetLines_owner REFERENCES dbo.Users(user_id),
    quantity        INT            NOT NULL CONSTRAINT DF_BudgetLines_quantity DEFAULT 1,
    unit_price      DECIMAL(18,2)  NOT NULL CONSTRAINT DF_BudgetLines_unit_price DEFAULT 0,
    total_amount    AS (CAST(quantity * unit_price AS DECIMAL(18,2))) PERSISTED,
    notes           NVARCHAR(MAX)  NULL,
    is_deleted      BIT            NOT NULL CONSTRAINT DF_BudgetLines_is_deleted DEFAULT 0,
    created_by      INT            NOT NULL CONSTRAINT FK_BudgetLines_created_by REFERENCES dbo.Users(user_id),
    created_at      DATETIME2      NOT NULL CONSTRAINT DF_BudgetLines_created_at DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL CONSTRAINT DF_BudgetLines_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_BudgetLines_quantity CHECK (quantity > 0),
    CONSTRAINT CK_BudgetLines_unit_price CHECK (unit_price >= 0)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'UX_BudgetLines_code')
CREATE UNIQUE INDEX UX_BudgetLines_code ON dbo.BudgetLines (code) WHERE code IS NOT NULL;
GO

/* -----------------------------------------------------------------------------
   BudgetAllocations - planned spend of a budget line per financial year.
   A multi-year line (e.g. Data Centre 43M in 26/27 + 27M in 27/28) has one row
   per year. q1..q4 hold the optional quarterly plan for that year.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.BudgetAllocations', 'U') IS NULL
CREATE TABLE dbo.BudgetAllocations (
    allocation_id   INT IDENTITY(1,1) PRIMARY KEY,
    budget_line_id  INT           NOT NULL CONSTRAINT FK_BudgetAllocations_line REFERENCES dbo.BudgetLines(budget_line_id),
    fy_id           INT           NOT NULL CONSTRAINT FK_BudgetAllocations_fy REFERENCES dbo.FinancialYears(fy_id),
    planned_amount  DECIMAL(18,2) NOT NULL CONSTRAINT DF_BudgetAllocations_planned DEFAULT 0,
    q1_amount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_BudgetAllocations_q1 DEFAULT 0,
    q2_amount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_BudgetAllocations_q2 DEFAULT 0,
    q3_amount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_BudgetAllocations_q3 DEFAULT 0,
    q4_amount       DECIMAL(18,2) NOT NULL CONSTRAINT DF_BudgetAllocations_q4 DEFAULT 0,
    CONSTRAINT UQ_BudgetAllocations_line_fy UNIQUE (budget_line_id, fy_id),
    CONSTRAINT CK_BudgetAllocations_amounts CHECK (planned_amount >= 0 AND q1_amount >= 0 AND q2_amount >= 0 AND q3_amount >= 0 AND q4_amount >= 0)
);
GO

/* -----------------------------------------------------------------------------
   WorkflowStages - the procurement steps, in order. sla_days is the target
   number of days an item should spend at a step; used to flag overdue items.
   The Head of ICT can add / reorder / deactivate steps without code changes.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.WorkflowStages', 'U') IS NULL
CREATE TABLE dbo.WorkflowStages (
    stage_id     INT IDENTITY(1,1) PRIMARY KEY,
    code         NVARCHAR(30)  NOT NULL CONSTRAINT UQ_WorkflowStages_code UNIQUE,
    name         NVARCHAR(150) NOT NULL,
    stage_group  NVARCHAR(30)  NOT NULL
                 CONSTRAINT CK_WorkflowStages_group CHECK (stage_group IN ('Memo', 'eGP', 'ToR', 'Tender', 'ERP', 'Contract', 'Delivery', 'Closed')),
    sort_order   INT           NOT NULL,
    sla_days     INT           NOT NULL CONSTRAINT DF_WorkflowStages_sla DEFAULT 5,
    is_active    BIT           NOT NULL CONSTRAINT DF_WorkflowStages_is_active DEFAULT 1,
    CONSTRAINT CK_WorkflowStages_sla CHECK (sla_days >= 0)
);
GO

/* -----------------------------------------------------------------------------
   Procurements - one procurement activity (replaces rows of the "All list"
   sheet and the process columns of the budget sheets).
   current_stage_id / stage_entered_at are maintained by the app whenever a
   StageEvent is recorded, so dashboards can query "where is everything now"
   cheaply without scanning the full history.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Procurements', 'U') IS NULL
CREATE TABLE dbo.Procurements (
    procurement_id          INT IDENTITY(1,1) PRIMARY KEY,
    reference               NVARCHAR(30)  NULL,
    title                   NVARCHAR(500) NOT NULL,
    budget_line_id          INT           NULL     CONSTRAINT FK_Procurements_line REFERENCES dbo.BudgetLines(budget_line_id),
    fy_id                   INT           NOT NULL CONSTRAINT FK_Procurements_fy REFERENCES dbo.FinancialYears(fy_id),
    owner_id                INT           NOT NULL CONSTRAINT FK_Procurements_owner REFERENCES dbo.Users(user_id),
    category_id             INT           NOT NULL CONSTRAINT FK_Procurements_category REFERENCES dbo.Lookups(lookup_id),
    priority_id             INT           NULL     CONSTRAINT FK_Procurements_priority REFERENCES dbo.Lookups(lookup_id),
    acquisition_method_id   INT           NULL     CONSTRAINT FK_Procurements_method REFERENCES dbo.Lookups(lookup_id),
    scm_officer_id          INT           NULL     CONSTRAINT FK_Procurements_scm REFERENCES dbo.Lookups(lookup_id),
    status                  NVARCHAR(20)  NOT NULL CONSTRAINT DF_Procurements_status DEFAULT 'Not Started'
                            CONSTRAINT CK_Procurements_status CHECK (status IN ('Not Started', 'In Progress', 'On Hold', 'Completed', 'Cancelled', 'Rejected')),
    current_stage_id        INT           NULL     CONSTRAINT FK_Procurements_stage REFERENCES dbo.WorkflowStages(stage_id),
    stage_entered_at        DATE          NULL,
    tender_float_date       DATE          NULL,
    tender_opening_date     DATE          NULL,
    tender_days             AS (DATEDIFF(DAY, tender_float_date, tender_opening_date)),
    is_escalated            BIT           NOT NULL CONSTRAINT DF_Procurements_escalated DEFAULT 0,
    escalated_to            NVARCHAR(150) NULL,
    escalation_note         NVARCHAR(1000) NULL,
    notes                   NVARCHAR(MAX) NULL,
    is_deleted              BIT           NOT NULL CONSTRAINT DF_Procurements_is_deleted DEFAULT 0,
    created_by              INT           NOT NULL CONSTRAINT FK_Procurements_created_by REFERENCES dbo.Users(user_id),
    created_at              DATETIME2     NOT NULL CONSTRAINT DF_Procurements_created_at DEFAULT SYSUTCDATETIME(),
    updated_at              DATETIME2     NOT NULL CONSTRAINT DF_Procurements_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Procurements_tender_dates CHECK (tender_opening_date IS NULL OR tender_float_date IS NULL OR tender_opening_date >= tender_float_date)
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_Procurements_fy_status')
CREATE INDEX IX_Procurements_fy_status ON dbo.Procurements (fy_id, status) INCLUDE (owner_id, category_id, current_stage_id) WHERE is_deleted = 0;
GO

/* -----------------------------------------------------------------------------
   StageEvents - history of every step update an officer records, e.g.
   "eGP approval by HOD - Approved - 2026-09-07". Never updated, only inserted.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.StageEvents', 'U') IS NULL
CREATE TABLE dbo.StageEvents (
    event_id        INT IDENTITY(1,1) PRIMARY KEY,
    procurement_id  INT            NOT NULL CONSTRAINT FK_StageEvents_procurement REFERENCES dbo.Procurements(procurement_id),
    stage_id        INT            NOT NULL CONSTRAINT FK_StageEvents_stage REFERENCES dbo.WorkflowStages(stage_id),
    status          NVARCHAR(20)   NOT NULL
                    CONSTRAINT CK_StageEvents_status CHECK (status IN ('Pending', 'In Progress', 'Approved', 'Completed', 'Rejected', 'Returned')),
    event_date      DATE           NOT NULL,
    notes           NVARCHAR(1000) NULL,
    recorded_by     INT            NOT NULL CONSTRAINT FK_StageEvents_recorded_by REFERENCES dbo.Users(user_id),
    created_at      DATETIME2      NOT NULL CONSTRAINT DF_StageEvents_created_at DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_StageEvents_procurement')
CREATE INDEX IX_StageEvents_procurement ON dbo.StageEvents (procurement_id, event_date, event_id);
GO

/* -----------------------------------------------------------------------------
   Contracts - awarded contracts (including multi-year support contracts).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Contracts', 'U') IS NULL
CREATE TABLE dbo.Contracts (
    contract_id      INT IDENTITY(1,1) PRIMARY KEY,
    procurement_id   INT            NOT NULL CONSTRAINT FK_Contracts_procurement REFERENCES dbo.Procurements(procurement_id),
    contract_number  NVARCHAR(50)   NOT NULL CONSTRAINT UQ_Contracts_number UNIQUE,
    supplier_name    NVARCHAR(200)  NOT NULL,
    contract_value   DECIMAL(18,2)  NOT NULL,
    start_date       DATE           NOT NULL,
    end_date         DATE           NOT NULL,
    status           NVARCHAR(20)   NOT NULL CONSTRAINT DF_Contracts_status DEFAULT 'Active'
                     CONSTRAINT CK_Contracts_status CHECK (status IN ('Active', 'Completed', 'Expired', 'Terminated')),
    notes            NVARCHAR(MAX)  NULL,
    is_deleted       BIT            NOT NULL CONSTRAINT DF_Contracts_is_deleted DEFAULT 0,
    created_by       INT            NOT NULL CONSTRAINT FK_Contracts_created_by REFERENCES dbo.Users(user_id),
    created_at       DATETIME2      NOT NULL CONSTRAINT DF_Contracts_created_at DEFAULT SYSUTCDATETIME(),
    updated_at       DATETIME2      NOT NULL CONSTRAINT DF_Contracts_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Contracts_value CHECK (contract_value >= 0),
    CONSTRAINT CK_Contracts_dates CHECK (end_date >= start_date)
);
GO

/* -----------------------------------------------------------------------------
   Invoices - supplier invoices against a contract.
   Lifecycle: Received -> Verified -> Approved -> Paid (or Rejected).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Invoices', 'U') IS NULL
CREATE TABLE dbo.Invoices (
    invoice_id      INT IDENTITY(1,1) PRIMARY KEY,
    contract_id     INT            NOT NULL CONSTRAINT FK_Invoices_contract REFERENCES dbo.Contracts(contract_id),
    invoice_number  NVARCHAR(50)   NOT NULL,
    amount          DECIMAL(18,2)  NOT NULL,
    invoice_date    DATE           NOT NULL,
    received_date   DATE           NOT NULL,
    status          NVARCHAR(20)   NOT NULL CONSTRAINT DF_Invoices_status DEFAULT 'Received'
                    CONSTRAINT CK_Invoices_status CHECK (status IN ('Received', 'Verified', 'Approved', 'Paid', 'Rejected')),
    notes           NVARCHAR(1000) NULL,
    is_deleted      BIT            NOT NULL CONSTRAINT DF_Invoices_is_deleted DEFAULT 0,
    created_by      INT            NOT NULL CONSTRAINT FK_Invoices_created_by REFERENCES dbo.Users(user_id),
    created_at      DATETIME2      NOT NULL CONSTRAINT DF_Invoices_created_at DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL CONSTRAINT DF_Invoices_updated_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT UQ_Invoices_contract_number UNIQUE (contract_id, invoice_number),
    CONSTRAINT CK_Invoices_amount CHECK (amount > 0)
);
GO

/* -----------------------------------------------------------------------------
   Payments - payments made against an invoice (an invoice may be paid in parts).
   Actual expenditure per FY / quarter on the dashboard comes from this table.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Payments', 'U') IS NULL
CREATE TABLE dbo.Payments (
    payment_id     INT IDENTITY(1,1) PRIMARY KEY,
    invoice_id     INT            NOT NULL CONSTRAINT FK_Payments_invoice REFERENCES dbo.Invoices(invoice_id),
    amount         DECIMAL(18,2)  NOT NULL,
    payment_date   DATE           NOT NULL,
    reference      NVARCHAR(50)   NULL,     -- payment voucher / EFT reference
    notes          NVARCHAR(1000) NULL,
    is_deleted     BIT            NOT NULL CONSTRAINT DF_Payments_is_deleted DEFAULT 0,
    created_by     INT            NOT NULL CONSTRAINT FK_Payments_created_by REFERENCES dbo.Users(user_id),
    created_at     DATETIME2      NOT NULL CONSTRAINT DF_Payments_created_at DEFAULT SYSUTCDATETIME(),
    CONSTRAINT CK_Payments_amount CHECK (amount > 0)
);
GO

/* -----------------------------------------------------------------------------
   Tasks - follow-up items (replaces the T-00x "Follow up on ..." sections).
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.Tasks', 'U') IS NULL
CREATE TABLE dbo.Tasks (
    task_id         INT IDENTITY(1,1) PRIMARY KEY,
    title           NVARCHAR(300)  NOT NULL,
    description     NVARCHAR(MAX)  NULL,
    owner_id        INT            NOT NULL CONSTRAINT FK_Tasks_owner REFERENCES dbo.Users(user_id),
    procurement_id  INT            NULL     CONSTRAINT FK_Tasks_procurement REFERENCES dbo.Procurements(procurement_id),
    priority_id     INT            NULL     CONSTRAINT FK_Tasks_priority REFERENCES dbo.Lookups(lookup_id),
    due_date        DATE           NULL,
    status          NVARCHAR(20)   NOT NULL CONSTRAINT DF_Tasks_status DEFAULT 'Open'
                    CONSTRAINT CK_Tasks_status CHECK (status IN ('Open', 'In Progress', 'Done', 'Cancelled')),
    is_deleted      BIT            NOT NULL CONSTRAINT DF_Tasks_is_deleted DEFAULT 0,
    created_by      INT            NOT NULL CONSTRAINT FK_Tasks_created_by REFERENCES dbo.Users(user_id),
    created_at      DATETIME2      NOT NULL CONSTRAINT DF_Tasks_created_at DEFAULT SYSUTCDATETIME(),
    updated_at      DATETIME2      NOT NULL CONSTRAINT DF_Tasks_updated_at DEFAULT SYSUTCDATETIME()
);
GO

/* -----------------------------------------------------------------------------
   AuditLogs - who changed what and when. old/new values are stored as JSON.
   request_id matches the "request_id" field in the log files and the
   X-Request-Id response header, so a change can be traced to its request.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.AuditLogs', 'U') IS NULL
CREATE TABLE dbo.AuditLogs (
    audit_id    BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id     INT           NULL CONSTRAINT FK_AuditLogs_user REFERENCES dbo.Users(user_id),
    action      NVARCHAR(10)  NOT NULL CONSTRAINT CK_AuditLogs_action CHECK (action IN ('CREATE', 'UPDATE', 'DELETE')),
    entity      NVARCHAR(50)  NOT NULL,
    entity_id   INT           NOT NULL,
    old_values  NVARCHAR(MAX) NULL,
    new_values  NVARCHAR(MAX) NULL,
    request_id  NVARCHAR(64)  NULL,
    ip_address  NVARCHAR(45)  NULL,
    created_at  DATETIME2     NOT NULL CONSTRAINT DF_AuditLogs_created_at DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuditLogs_entity')
CREATE INDEX IX_AuditLogs_entity ON dbo.AuditLogs (entity, entity_id, created_at);
GO

/* -----------------------------------------------------------------------------
   AuthEvents - login history: successful logins, failed attempts (with the
   reason, which is never shown to the caller), password changes and resets.
   user_id is NULL when a login used an email that does not exist.
----------------------------------------------------------------------------- */
IF OBJECT_ID('dbo.AuthEvents', 'U') IS NULL
CREATE TABLE dbo.AuthEvents (
    event_id    BIGINT IDENTITY(1,1) PRIMARY KEY,
    user_id     INT           NULL CONSTRAINT FK_AuthEvents_user REFERENCES dbo.Users(user_id),
    email       NVARCHAR(150) NULL,
    event_type  NVARCHAR(30)  NOT NULL
                CONSTRAINT CK_AuthEvents_type CHECK (event_type IN ('LOGIN_SUCCESS', 'LOGIN_FAILED', 'PASSWORD_CHANGED', 'PASSWORD_RESET')),
    reason      NVARCHAR(100) NULL,      -- e.g. unknown_email, wrong_password, account_deactivated
    ip_address  NVARCHAR(45)  NULL,
    user_agent  NVARCHAR(400) NULL,
    request_id  NVARCHAR(64)  NULL,
    created_at  DATETIME2     NOT NULL CONSTRAINT DF_AuthEvents_created_at DEFAULT SYSUTCDATETIME()
);
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = 'IX_AuthEvents_created_at')
CREATE INDEX IX_AuthEvents_created_at ON dbo.AuthEvents (created_at DESC) INCLUDE (user_id, event_type);
GO

/* -----------------------------------------------------------------------------
   vw_Procurements - procurements with display names and live tracking figures.
   Used by the procurement list and the dashboard so the "overdue" and
   "progress" rules are defined in exactly one place:
     days_in_stage    = days since the item entered its current step
     is_overdue       = still open AND days_in_stage > the step's sla_days
     progress_percent = share of active steps already passed (100 if Completed)
----------------------------------------------------------------------------- */
CREATE OR ALTER VIEW dbo.vw_Procurements AS
SELECT
    p.procurement_id, p.reference, p.title,
    p.fy_id, fy.code AS fy_code,
    p.budget_line_id, bl.code AS budget_line_code, bl.description AS budget_line_description,
    p.owner_id, o.full_name AS owner_name,
    p.category_id, cat.value AS category,
    p.priority_id, pr.value AS priority, pr.sort_order AS priority_rank,
    p.acquisition_method_id, am.value AS acquisition_method,
    p.scm_officer_id, scm.value AS scm_officer,
    p.status,
    p.current_stage_id, ws.code AS current_stage_code, ws.name AS current_stage_name,
    ws.stage_group AS current_stage_group, ws.sort_order AS current_stage_order, ws.sla_days,
    p.stage_entered_at,
    DATEDIFF(DAY, p.stage_entered_at, CAST(SYSDATETIME() AS DATE)) AS days_in_stage,
    CAST(CASE
            WHEN p.status IN ('Not Started', 'In Progress')
             AND p.stage_entered_at IS NOT NULL
             AND DATEDIFF(DAY, p.stage_entered_at, CAST(SYSDATETIME() AS DATE)) > ws.sla_days
            THEN 1 ELSE 0
         END AS BIT) AS is_overdue,
    CASE
        WHEN p.status = 'Completed' THEN 100
        WHEN ws.stage_id IS NULL THEN 0
        ELSE stage_pos.passed * 100 / NULLIF(stage_pos.total, 0)
    END AS progress_percent,
    p.tender_float_date, p.tender_opening_date, p.tender_days,
    p.is_escalated, p.escalated_to, p.escalation_note,
    p.notes, p.created_by, p.created_at, p.updated_at
FROM dbo.Procurements p
JOIN dbo.FinancialYears fy      ON fy.fy_id = p.fy_id
JOIN dbo.Users o                ON o.user_id = p.owner_id
JOIN dbo.Lookups cat            ON cat.lookup_id = p.category_id
LEFT JOIN dbo.Lookups pr        ON pr.lookup_id = p.priority_id
LEFT JOIN dbo.Lookups am        ON am.lookup_id = p.acquisition_method_id
LEFT JOIN dbo.Lookups scm       ON scm.lookup_id = p.scm_officer_id
LEFT JOIN dbo.BudgetLines bl    ON bl.budget_line_id = p.budget_line_id
LEFT JOIN dbo.WorkflowStages ws ON ws.stage_id = p.current_stage_id
OUTER APPLY (
    SELECT SUM(CASE WHEN s.sort_order < ws.sort_order THEN 1 ELSE 0 END) AS passed,
           COUNT(*) AS total
    FROM dbo.WorkflowStages s
    WHERE s.is_active = 1
) stage_pos
WHERE p.is_deleted = 0;
GO
