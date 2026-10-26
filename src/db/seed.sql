/* =============================================================================
   BGTtracker - reference data
   Values come from the "Lists" sheet of ICT Task Tracker 26_27.xlsx.
   Idempotent: rows are only inserted when they do not already exist.
============================================================================= */

/* ---------------------------- Lookups ------------------------------------- */
;WITH src (lookup_type, value, sort_order) AS (
    SELECT * FROM (VALUES
        -- Categories
        ('category', 'ICT Equipment',          1),
        ('category', 'ICT Infrastructure',     2),
        ('category', 'ICT Software',           3),
        ('category', 'Maintenance & Support',  4),
        ('category', 'Consultancy',            5),
        ('category', 'Subscription & Support', 6),
        ('category', 'Extension of Time',      7),
        -- Priorities (sort_order = severity, used for ordering)
        ('priority', 'Low',      1),
        ('priority', 'Medium',   2),
        ('priority', 'High',     3),
        ('priority', 'Critical', 4),
        -- Acquisition methods
        ('acquisition_method', 'RFQ',                1),
        ('acquisition_method', 'Open Tender',        2),
        ('acquisition_method', 'Restricted Tender',  3),
        ('acquisition_method', 'Direct Procurement', 4),
        -- SCM officers (they do not log in; officers pick them from a list)
        ('scm_officer', 'Brigid Wanjau',      1),
        ('scm_officer', 'Happiness Kemunto',  2),
        ('scm_officer', 'Susan Cherono',      3),
        ('scm_officer', 'Winnie Kakai',       4),
        ('scm_officer', 'Tom Okello',         5),
        ('scm_officer', 'Eric Wamae',         6),
        ('scm_officer', 'Peter Ndichu',       7),
        ('scm_officer', 'Beldine Mganda',     8),
        ('scm_officer', 'Salat Abdinur',      9),
        ('scm_officer', 'Alex Kinyua',       10),
        ('scm_officer', 'Abdi Yusuf',        11),
        ('scm_officer', 'Elizabeth Karugia', 12),
        ('scm_officer', 'Joseph Kimaru',     13),
        ('scm_officer', 'Gentrix Kipchumba', 14)
    ) AS v (lookup_type, value, sort_order)
)
INSERT INTO dbo.Lookups (lookup_type, value, sort_order)
SELECT s.lookup_type, s.value, s.sort_order
FROM src s
WHERE NOT EXISTS (SELECT 1 FROM dbo.Lookups l WHERE l.lookup_type = s.lookup_type AND l.value = s.value);
GO

/* ------------------------- Financial years -------------------------------- */
;WITH src (code, start_date, end_date, is_current) AS (
    SELECT * FROM (VALUES
        ('2025/26', CAST('2025-07-01' AS DATE), CAST('2026-06-30' AS DATE), 0),
        ('2026/27', CAST('2026-07-01' AS DATE), CAST('2027-06-30' AS DATE), 1),
        ('2027/28', CAST('2027-07-01' AS DATE), CAST('2028-06-30' AS DATE), 0),
        ('2028/29', CAST('2028-07-01' AS DATE), CAST('2029-06-30' AS DATE), 0)
    ) AS v (code, start_date, end_date, is_current)
)
INSERT INTO dbo.FinancialYears (code, start_date, end_date, is_current)
SELECT s.code, s.start_date, s.end_date,
       -- never create a second "current" year if one already exists
       CASE WHEN s.is_current = 1 AND EXISTS (SELECT 1 FROM dbo.FinancialYears WHERE is_current = 1) THEN 0 ELSE s.is_current END
FROM src s
WHERE NOT EXISTS (SELECT 1 FROM dbo.FinancialYears f WHERE f.code = s.code);
GO

/* ------------------------- Workflow stages -------------------------------- */
-- Order mirrors the columns of the tracker sheets. sla_days are starting
-- targets; the Head of ICT can tune them from the app.
;WITH src (code, name, stage_group, sort_order, sla_days) AS (
    SELECT * FROM (VALUES
        ('MEMO_TO_DG',       'Memo delivered to DG',               'Memo',      10,  2),
        ('DG_APPROVAL',      'Memo approved by DG',                'Memo',      20,  5),
        ('EGP_PR_RAISED',    'PR raised on eGP',                   'eGP',       30,  3),
        ('EGP_HOD',          'eGP approval by HOD',                'eGP',       40,  3),
        ('EGP_DCS',          'eGP approval by DCS',                'eGP',       50,  3),
        ('EGP_SCM',          'eGP approval by SCM',                'eGP',       60,  3),
        ('EGP_DG',           'eGP approval by DG',                 'eGP',       70,  3),
        ('EGP_BOARD',        'eGP approval by Board',              'eGP',       80, 14),
        ('TOR_PREPARATION',  'ToR preparation by ICT',             'ToR',       90,  7),
        ('TOR_APPROVAL',     'ToR approval by ICT',                'ToR',      100,  3),
        ('TOR_TO_SCM',       'ToR submitted to SCM',               'ToR',      110,  2),
        ('SCM_STARTED',      'Acquisition process started by SCM', 'Tender',   120,  7),
        ('TENDER_FLOATED',   'Quotation / tender floated',         'Tender',   130, 21),
        ('TENDER_OPENED',    'Quotation / tender opened',          'Tender',   140,  2),
        ('EVALUATION',       'Evaluation',                         'Tender',   150, 14),
        ('ERP_PR_RAISED',    'PR raised on ERP',                   'ERP',      160,  3),
        ('ERP_HOD',          'ERP approval by HOD',                'ERP',      170,  3),
        ('ERP_FINANCE',      'ERP approval by Finance',            'ERP',      180,  5),
        ('ERP_DG',           'ERP approval by DG',                 'ERP',      190,  3),
        ('ERP_SCM',          'ERP approval by SCM',                'ERP',      200,  3),
        ('CONTRACT_AWARDED', 'Contract awarded / LPO issued',      'Contract', 210,  7),
        ('DELIVERY',         'Delivery, inspection & acceptance',  'Delivery', 220, 30),
        ('CLOSED',           'Closed',                             'Closed',   230,  7)
    ) AS v (code, name, stage_group, sort_order, sla_days)
)
INSERT INTO dbo.WorkflowStages (code, name, stage_group, sort_order, sla_days)
SELECT s.code, s.name, s.stage_group, s.sort_order, s.sla_days
FROM src s
WHERE NOT EXISTS (SELECT 1 FROM dbo.WorkflowStages w WHERE w.code = s.code);
GO
