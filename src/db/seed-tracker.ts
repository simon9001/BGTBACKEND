import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import sql from 'mssql';
import { z } from 'zod';
import initDatabaseConnection, { closeDatabaseConnection, withTransaction } from './dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import { recomputeCurrentStage } from '../procurements/procurement.service.js';

/**
 * Imports the data of "ICT Task Tracker 26_27.xlsx" into the database. The real
 * values live in src/db/data/tracker-data.json, which is git-ignored because it
 * holds department data; tracker-data.example.json shows its format.
 *
 *   pnpm db:seed-tracker
 *
 * Run after `pnpm db:migrate` and `pnpm db:seed-admin` (the admin account is
 * recorded as the creator of every row). Runs in a single transaction and skips
 * rows that already exist, so it is safe to run more than once and never
 * overwrites changes made in the app.
 *
 * How the sheets map to tables:
 *   Lists sheet           -> Lookups, added on the first import only, so a value
 *                            renamed or removed in the app does not come back
 *   Section header rows   -> Lookups of type "section" (the empty ones too)
 *   Lists sheet "Owners"  -> Users (officers who cannot log in until the system
 *                            administrator sets their real email and password)
 *   Budget sheets         -> BudgetLines + BudgetAllocations, plus one Procurement
 *                            per line to carry its process columns
 *   All list T-001 memos  -> Memos, plus StageEvents on the procurement(s) each memo requests
 *   All list T-006/T-007  -> Procurements (they have a category, status and notes)
 *   All list T-002        -> Tasks
 */

// The sheet ticks some steps "Yes" without a date, but StageEvents needs one.
// These use the file's undatedStepDate and say so in their notes.
const UNDATED_NOTE = 'Imported from tracker: marked Yes, date not recorded in the sheet';

const DATA_FILE = fileURLToPath(new URL('./data/tracker-data.json', import.meta.url));

// Checks the data file up front, so a bad value fails before the database is touched
const TrackerDataSchema = z.object({
    financialYears: z.array(z.string()).min(1),
    currentFinancialYear: z.string(),
    lists: z.record(z.string(), z.array(z.union([z.string(), z.number()]))), // the Lists sheet, column by column
    sections: z.array(z.object({ code: z.string(), name: z.string(), sheet: z.string(), sortOrder: z.number() })),
    undatedStepDate: z.iso.date(),
    owners: z.array(z.string()),
    budgetLines: z.array(z.object({
        code: z.string(),
        description: z.string(),
        section: z.string(),
        category: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
        owner: z.string(),
        priority: z.string().nullable(),
        amounts: z.array(z.number()), // planned spend for financialYears, in order
        quarters: z.array(z.number()).length(4), // Q1-Q4 of the current financial year
    })),
    // One memo can request several budget lines
    memos: z.array(z.object({
        section: z.string(),
        reference: z.string(),
        title: z.string(),
        owner: z.string(),
        category: z.string(),
        priority: z.string().nullable(),
        status: z.string(),
        dgStatus: z.string().nullable(),
        delivered: z.iso.date().nullable(),
        approved: z.iso.date().nullable(),
        lines: z.array(z.string()),
    })),
    // Steps ticked "Yes" on a budget sheet row, by budget line code
    budgetSheetProgress: z.record(z.string(), z.object({
        method: z.string(),
        steps: z.array(z.object({ stage: z.string(), status: z.string() })),
    })),
    // All list activities with no budget line behind them
    standaloneProcurements: z.array(z.object({
        section: z.string(),
        reference: z.string(),
        title: z.string(),
        owner: z.string(),
        category: z.string(),
        priority: z.string().nullable(),
        status: z.string(),
        notes: z.string().nullable(),
    })),
    // A null owner means the sheet names nobody, so it goes to the Head of ICT to assign
    tasks: z.array(z.object({ title: z.string(), owner: z.string().nullable(), section: z.string() })),
}).refine(
    (data) => data.budgetLines.every((l) => l.amounts.length === data.financialYears.length),
    { message: 'Every budget line needs one amount per financial year' },
).refine(
    (data) => {
        const currentIndex = data.financialYears.indexOf(data.currentFinancialYear);
        return data.budgetLines.every((l) => l.quarters.reduce((sum, q) => sum + q, 0) <= (l.amounts[currentIndex] ?? 0));
    },
    { message: 'A budget line\'s quarters cannot add up to more than its amount for the current year' },
);

const loadTrackerData = () => {
    if (!existsSync(DATA_FILE)) {
        throw new Error(`${DATA_FILE} not found. It is git-ignored: copy it from a team member, or use tracker-data.example.json as a template.`);
    }
    return TrackerDataSchema.parse(JSON.parse(readFileSync(DATA_FILE, 'utf8')));
};

// Clearly fake address: the sheet has no emails and a guessed one could be a real person's
const placeholderEmail = (fullName: string) => `${fullName.toLowerCase().replace(/\s+/g, '.')}@placeholder.invalid`;

const run = async () => {
    const data = loadTrackerData();
    const pool = await initDatabaseConnection();

    const admin = await pool.request()
        .query(`SELECT TOP 1 user_id FROM dbo.Users WHERE role = 'admin' AND is_active = 1 ORDER BY user_id`);
    const adminId: number | undefined = admin.recordset[0]?.user_id;
    if (!adminId) {
        throw new Error('No active admin found. Run pnpm db:seed-admin first.');
    }

    // Hashed outside the transaction because bcrypt is slow. The random password
    // is thrown away, so these accounts cannot log in until an admin resets them.
    const unusableHash = await bcrypt.hash(randomBytes(32).toString('hex'), 10);

    const created = await withTransaction(async (tx) => {
        const query = () => new sql.Request(tx);
        const counts = { users: 0, budgetLines: 0, allocations: 0, procurements: 0, stageEvents: 0, memos: 0, tasks: 0 };

        /* ---- Lists and sections: only on the first import (no budget lines yet) --- */
        const isFirstImport = (await query().query(`SELECT COUNT(*) AS total FROM dbo.BudgetLines`)).recordset[0].total === 0;
        if (isFirstImport) {
            const wanted: { type: string; values: string[] }[] = [
                { type: 'category', values: (data.lists.Category ?? []).map(String) },
                { type: 'priority', values: (data.lists.Priority ?? []).map(String) },
                { type: 'acquisition_method', values: (data.lists['Acquisition Method'] ?? []).map(String) },
                { type: 'scm_officer', values: (data.lists['SCM Officers'] ?? []).map(String) },
                { type: 'section', values: data.sections.map((s) => `${s.code} - ${s.name}`) },
            ];
            for (const { type, values } of wanted) {
                for (const [index, value] of values.entries()) {
                    await query()
                        .input('type', sql.NVarChar(50), type)
                        .input('value', sql.NVarChar(150), value)
                        .input('sort_order', sql.Int, index + 1)
                        .query(`IF NOT EXISTS (SELECT 1 FROM dbo.Lookups WHERE lookup_type = @type AND value = @value)
                                INSERT INTO dbo.Lookups (lookup_type, value, sort_order) VALUES (@type, @value, @sort_order)`);
                }
            }
        }

        const lookups = await query().query(`SELECT lookup_id, lookup_type, value FROM dbo.Lookups`);
        const sectionId = (code: string): number => {
            const row = lookups.recordset.find((l) => l.lookup_type === 'section' && String(l.value).startsWith(`${code} - `));
            if (!row) throw new Error(`Section not found: ${code}. Run pnpm db:migrate first.`);
            return row.lookup_id;
        };
        const lookupId = (type: string, value: string): number => {
            const row = lookups.recordset.find((l) => l.lookup_type === type && l.value === value);
            if (!row) throw new Error(`Lookup not found: ${type} = ${value}. Run pnpm db:migrate first.`);
            return row.lookup_id;
        };

        const stages = await query().query(`SELECT stage_id, code FROM dbo.WorkflowStages`);
        const stageId = (code: string): number => {
            const row = stages.recordset.find((s) => s.code === code);
            if (!row) throw new Error(`Workflow stage not found: ${code}. Run pnpm db:migrate first.`);
            return row.stage_id;
        };

        const years = await query().query(`SELECT fy_id, code FROM dbo.FinancialYears`);
        const fyId = (code: string): number => {
            const row = years.recordset.find((y) => y.code === code);
            if (!row) throw new Error(`Financial year not found: ${code}. Run pnpm db:migrate first.`);
            return row.fy_id;
        };

        /* ------------------------------ Users ------------------------------- */
        const userIds = new Map<string, number>();
        for (const fullName of data.owners) {
            const email = placeholderEmail(fullName);
            const existing = await query()
                .input('full_name', sql.NVarChar(150), fullName)
                .input('email', sql.NVarChar(150), email)
                .query(`SELECT TOP 1 user_id FROM dbo.Users WHERE full_name = @full_name OR email = @email ORDER BY user_id`);

            let userId: number | undefined = existing.recordset[0]?.user_id;
            if (!userId) {
                const result = await query()
                    .input('full_name', sql.NVarChar(150), fullName)
                    .input('email', sql.NVarChar(150), email)
                    .input('password_hash', sql.NVarChar(255), unusableHash)
                    .query(`INSERT INTO dbo.Users (full_name, email, password_hash, role)
                            OUTPUT INSERTED.user_id
                            VALUES (@full_name, @email, @password_hash, 'officer')`);
                userId = result.recordset[0].user_id as number;
                await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'Users', entityId: userId, newValues: { full_name: fullName, email, role: 'officer' } });
                counts.users++;
            }
            userIds.set(fullName, userId);
        }
        const userId = (fullName: string): number => {
            const id = userIds.get(fullName);
            if (!id) throw new Error(`Owner is not in the owners list: ${fullName}`);
            return id;
        };

        /* Inserts a procurement unless its reference exists. Returns the new id, or null if skipped. */
        const insertProcurement = async (p: {
            reference: string; title: string; budgetLineId: number | null; section: string; owner: string; category: string;
            priority: string | null; method: string | null; status: string; notes: string | null;
        }): Promise<number | null> => {
            const existing = await query()
                .input('reference', sql.NVarChar(30), p.reference)
                .query(`SELECT procurement_id FROM dbo.Procurements WHERE reference = @reference`);
            if (existing.recordset.length > 0) return null;

            const result = await query()
                .input('reference', sql.NVarChar(30), p.reference)
                .input('title', sql.NVarChar(500), p.title)
                .input('budget_line_id', sql.Int, p.budgetLineId)
                .input('section_id', sql.Int, sectionId(p.section))
                .input('fy_id', sql.Int, fyId(data.currentFinancialYear))
                .input('owner_id', sql.Int, userId(p.owner))
                .input('category_id', sql.Int, lookupId('category', p.category))
                .input('priority_id', sql.Int, p.priority ? lookupId('priority', p.priority) : null)
                .input('acquisition_method_id', sql.Int, p.method ? lookupId('acquisition_method', p.method) : null)
                .input('status', sql.NVarChar(20), p.status)
                .input('notes', sql.NVarChar(sql.MAX), p.notes)
                .input('created_by', sql.Int, adminId)
                .query(`INSERT INTO dbo.Procurements (reference, title, budget_line_id, section_id, fy_id, owner_id, category_id, priority_id,
                                                      acquisition_method_id, status, notes, created_by)
                        OUTPUT INSERTED.procurement_id
                        VALUES (@reference, @title, @budget_line_id, @section_id, @fy_id, @owner_id, @category_id, @priority_id,
                                @acquisition_method_id, @status, @notes, @created_by)`);
            const procurementId: number = result.recordset[0].procurement_id;
            await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'Procurements', entityId: procurementId, newValues: p });
            counts.procurements++;
            return procurementId;
        };

        const insertStageEvent = async (procurementId: number, stage: string, status: string, eventDate: string, notes: string, recordedBy: number) => {
            const result = await query()
                .input('procurement_id', sql.Int, procurementId)
                .input('stage_id', sql.Int, stageId(stage))
                .input('status', sql.NVarChar(20), status)
                .input('event_date', sql.Date, new Date(eventDate))
                .input('notes', sql.NVarChar(1000), notes)
                .input('recorded_by', sql.Int, recordedBy)
                .query(`INSERT INTO dbo.StageEvents (procurement_id, stage_id, status, event_date, notes, recorded_by)
                        OUTPUT INSERTED.event_id
                        VALUES (@procurement_id, @stage_id, @status, @event_date, @notes, @recorded_by)`);
            await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'StageEvents', entityId: result.recordset[0].event_id, newValues: { procurement_id: procurementId, stage, status, event_date: eventDate } });
            counts.stageEvents++;
        };

        /* ---------------- Budget lines, allocations, procurements ------------ */
        for (const budgetLine of data.budgetLines) {
            const existing = await query()
                .input('code', sql.NVarChar(20), budgetLine.code)
                .query(`SELECT budget_line_id FROM dbo.BudgetLines WHERE code = @code`);

            let budgetLineId: number | undefined = existing.recordset[0]?.budget_line_id;
            if (!budgetLineId) {
                const result = await query()
                    .input('code', sql.NVarChar(20), budgetLine.code)
                    .input('description', sql.NVarChar(500), budgetLine.description)
                    .input('category_id', sql.Int, lookupId('category', budgetLine.category))
                    .input('section_id', sql.Int, sectionId(budgetLine.section))
                    .input('priority_id', sql.Int, budgetLine.priority ? lookupId('priority', budgetLine.priority) : null)
                    .input('owner_id', sql.Int, userId(budgetLine.owner))
                    .input('quantity', sql.Int, budgetLine.quantity)
                    .input('unit_price', sql.Decimal(18, 2), budgetLine.unitPrice)
                    .input('created_by', sql.Int, adminId)
                    .query(`INSERT INTO dbo.BudgetLines (code, description, category_id, section_id, priority_id, owner_id, quantity, unit_price, created_by)
                            OUTPUT INSERTED.budget_line_id
                            VALUES (@code, @description, @category_id, @section_id, @priority_id, @owner_id, @quantity, @unit_price, @created_by)`);
                budgetLineId = result.recordset[0].budget_line_id as number;
                await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'BudgetLines', entityId: budgetLineId, newValues: budgetLine });
                counts.budgetLines++;

                // Years with nothing planned get no row
                for (const [index, amount] of budgetLine.amounts.entries()) {
                    if (amount === 0) continue;
                    // The sheets' Q1-Q4 columns are for the current year
                    const fyCode = data.financialYears[index]!;
                    const [q1 = 0, q2 = 0, q3 = 0, q4 = 0] = fyCode === data.currentFinancialYear ? budgetLine.quarters : [];
                    await query()
                        .input('budget_line_id', sql.Int, budgetLineId)
                        .input('fy_id', sql.Int, fyId(fyCode))
                        .input('planned_amount', sql.Decimal(18, 2), amount)
                        .input('q1', sql.Decimal(18, 2), q1)
                        .input('q2', sql.Decimal(18, 2), q2)
                        .input('q3', sql.Decimal(18, 2), q3)
                        .input('q4', sql.Decimal(18, 2), q4)
                        .query(`INSERT INTO dbo.BudgetAllocations (budget_line_id, fy_id, planned_amount, q1_amount, q2_amount, q3_amount, q4_amount)
                                VALUES (@budget_line_id, @fy_id, @planned_amount, @q1, @q2, @q3, @q4)`);
                    counts.allocations++;
                }
            }

            const progress = data.budgetSheetProgress[budgetLine.code];
            const procurementId = await insertProcurement({
                reference: budgetLine.code,
                title: budgetLine.description,
                budgetLineId,
                section: budgetLine.section,
                owner: budgetLine.owner,
                category: budgetLine.category,
                priority: budgetLine.priority,
                method: progress?.method ?? null,
                status: 'Not Started',
                notes: null,
            });
            if (procurementId === null) continue; // already imported: leave its history alone

            const memo = data.memos.find((m) => m.lines.includes(budgetLine.code));
            if (memo?.delivered && memo.approved) {
                await insertStageEvent(procurementId, 'MEMO_TO_DG', 'Completed', memo.delivered, memo.title, userId(memo.owner));
                await insertStageEvent(procurementId, 'DG_APPROVAL', 'Approved', memo.approved, memo.title, userId(memo.owner));
            }
            for (const step of progress?.steps ?? []) {
                await insertStageEvent(procurementId, step.stage, step.status, data.undatedStepDate, UNDATED_NOTE, adminId);
            }
            await recomputeCurrentStage(tx, procurementId);
        }

        /* --------------------- Activities with no budget line ---------------- */
        for (const activity of data.standaloneProcurements) {
            await insertProcurement({ ...activity, budgetLineId: null, method: null });
        }

        /* ------------------------------- Memos ------------------------------- */
        for (const memo of data.memos) {
            const existing = await query()
                .input('reference', sql.NVarChar(30), memo.reference)
                .query(`SELECT memo_id FROM dbo.Memos WHERE reference = @reference`);
            if (existing.recordset.length > 0) continue;

            const result = await query()
                .input('reference', sql.NVarChar(30), memo.reference)
                .input('title', sql.NVarChar(500), memo.title)
                .input('fy_id', sql.Int, fyId(data.currentFinancialYear))
                .input('owner_id', sql.Int, userId(memo.owner))
                .input('category_id', sql.Int, lookupId('category', memo.category))
                .input('priority_id', sql.Int, memo.priority ? lookupId('priority', memo.priority) : null)
                .input('delivered_date', sql.Date, memo.delivered ? new Date(memo.delivered) : null)
                .input('approved_date', sql.Date, memo.approved ? new Date(memo.approved) : null)
                .input('dg_status', sql.NVarChar(20), memo.dgStatus)
                .input('status', sql.NVarChar(20), memo.status)
                .input('created_by', sql.Int, adminId)
                .query(`INSERT INTO dbo.Memos (reference, title, fy_id, owner_id, category_id, priority_id, delivered_date, approved_date, dg_status, status, created_by)
                        OUTPUT INSERTED.memo_id
                        VALUES (@reference, @title, @fy_id, @owner_id, @category_id, @priority_id, @delivered_date, @approved_date, @dg_status, @status, @created_by)`);
            await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'Memos', entityId: result.recordset[0].memo_id, newValues: memo });
            counts.memos++;
        }

        /* ------------------------------- Tasks ------------------------------- */
        for (const task of data.tasks) {
            const existing = await query()
                .input('title', sql.NVarChar(300), task.title)
                .input('section_id', sql.Int, sectionId(task.section))
                .query(`UPDATE dbo.Tasks SET section_id = @section_id WHERE title = @title AND section_id IS NULL;
                        SELECT task_id FROM dbo.Tasks WHERE title = @title`);
            if (existing.recordset.length > 0) continue;

            const result = await query()
                .input('title', sql.NVarChar(300), task.title)
                .input('owner_id', sql.Int, task.owner ? userId(task.owner) : adminId)
                .input('section_id', sql.Int, sectionId(task.section))
                .input('created_by', sql.Int, adminId)
                .query(`INSERT INTO dbo.Tasks (title, owner_id, section_id, created_by)
                        OUTPUT INSERTED.task_id
                        VALUES (@title, @owner_id, @section_id, @created_by)`);
            await writeAudit(tx, { userId: adminId, action: 'CREATE', entity: 'Tasks', entityId: result.recordset[0].task_id, newValues: task });
            counts.tasks++;
        }

        return counts;
    });

    console.log('✅ Tracker data imported. Rows created:', created);
};

run()
    .catch((error) => {
        console.error('❌ Tracker import failed:', error.message ?? error);
        process.exitCode = 1;
    })
    .finally(closeDatabaseConnection);
