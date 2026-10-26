# BGTtracker API

Backend for the ICT Department **Budget & Procurement Tracker** dashboard.
Built with **Hono + TypeScript + Microsoft SQL Server**.

ICT officers log in and record what is happening with each budget line and procurement.
That covers memos, eGP/ERP approvals, ToR, tenders, contracts, invoices and payments.
The Head of ICT gets a live dashboard across all financial years.

## Getting started

```bash
pnpm install
cp .env.example .env            # then fill in SQL credentials and a JWT secret

# create the database once in SSMS:  CREATE DATABASE BGTtracker;
pnpm db:migrate                 # creates tables + seeds lookups, financial years, workflow steps
pnpm db:seed-admin -- "Full Name" head.ict@example.com "StrongPass1"

pnpm dev                        # http://localhost:4000
```

| Script | What it does |
|---|---|
| `pnpm dev` | Run with auto-reload |
| `pnpm build` / `pnpm start` | Compile to `dist/` and run it |
| `pnpm typecheck` | Type-check without building |
| `pnpm db:migrate` | Run `src/db/schema.sql` + `seed.sql` (safe to re-run) |
| `pnpm db:seed-admin` | Create the first Head of ICT account |

## Folder structure

Each feature has its own folder with three layers:
**routes** (URLs + who may call them) → **controller** (validate input, check access, shape the response) → **service** (SQL).

```
src/
├── index.ts                 app setup, global middleware, route mounting, error handler
├── config/env.ts            validated environment variables
├── db/                      connection pool, schema.sql, seed.sql, migrate + seed-admin scripts
├── middleware/              bearAuth (JWT + roles), validation helpers, rate limiters
├── validators/              zod schemas, one file per feature
├── types/hono.ts            AppEnv / AuthUser types for typed `c.get('user')`
├── utils/                   HttpError, access rules, pagination, money helpers
├── auth/                    login, me, change password
├── users/                   staff accounts (Head of ICT)
├── lookups/                 dropdown values (replaces the "Lists" sheet)
├── financial-years/         FY list + current year
├── workflow-stages/         procurement steps and SLA days
├── budget-lines/            planned purchases + allocations per FY / quarter
├── procurements/            procurement tracking + recording workflow steps
├── tasks/                   follow-up items
├── contracts/               awarded contracts
├── invoices/                supplier invoices
├── payments/                payments (= actual expenditure)
├── dashboard/               chart/KPI endpoints
└── audit/                   audit trail
```

## Access control

| Role | Can do |
|---|---|
| `admin` (Head of ICT) | Everything. Manages users, lookups, financial years and workflow steps, and reassigns owners |
| `officer` | Sees everything. Creates records and edits **only items they own** (contracts, invoices and payments follow the procurement's owner) |
| `viewer` | Read-only |

Records are soft-deleted (`is_deleted`), never removed.

## Audit, logging & monitoring

Each audit question has its own record:

| Question | Where to look |
|---|---|
| Who changed which record, and what was the old and new value? | `AuditLogs` table: `GET /api/audit-logs` (admin) |
| Who logged in, when, from which IP, and who failed? | `AuthEvents` table: `GET /api/audit-logs/auth-events` (admin) |
| What requests came in, who made them, and what failed? | Log files in `logs/` |
| Is the app healthy, and how busy or slow is it? | Prometheus metrics at `/metrics` |

**Request id.** Every response carries an `X-Request-Id` header. The same id appears in the log lines, in `AuditLogs.request_id` and `AuthEvents.request_id`, and in the body of a 500 response. That lets you trace one action across all three records.

**Log files.** Logs are written one JSON object per line, to `logs/app.YYYY-MM-DD.N.log`. A new file starts each day, and files are kept for `LOG_RETENTION_DAYS` days. Each line has a `channel`:

| Channel | What it contains |
|---|---|
| `http` | Every request: method, route, status, duration, user, IP |
| `security` | Logins, failed logins, invalid tokens, permission denials |
| `audit` | Every committed create, update or delete |
| `db` | Database connection events |
| `app` | Startup, shutdown, unexpected errors |

Passwords and tokens are always redacted. Request bodies are never logged.

```powershell
Select-String -Path logs\*.log -Pattern '"channel":"security"'
Select-String -Path logs\*.log -Pattern '"request_id":"<id>"'
```

**Prometheus.** Metrics are served at `GET /metrics`. In production this needs `METRICS_TOKEN`; it's open in development if no token is set.

| Metric | Meaning |
|---|---|
| `bgt_http_requests_total`, `bgt_http_request_duration_seconds` | Traffic and response times per route |
| `bgt_auth_logins_total{result}` | Logins: success, invalid_credentials, deactivated |
| `bgt_auth_denied_total{reason}` | Refused requests: missing, expired or invalid token, inactive user, wrong role, not the owner |
| `bgt_data_changes_total{entity,action}` | Committed changes per table |
| `bgt_app_errors_total` | Unexpected 500 errors |
| `bgt_db_pool_connections{state}` | SQL connection pool usage |
| `bgt_process_*`, `bgt_nodejs_*` | CPU, memory, event loop |

See [monitoring/prometheus.yml](monitoring/prometheus.yml) for an example scrape config, and [monitoring/alerts.yml](monitoring/alerts.yml) for alert rules (failed-login spikes, suspicious denials, API down, errors, slow responses). Grafana can use Prometheus as a data source to chart these.

## API overview

All routes are under `/api` and need `Authorization: Bearer <token>`, except `POST /api/auth/login`.

| Area | Endpoints |
|---|---|
| Auth | `POST /auth/login` · `GET /auth/me` · `PUT /auth/change-password` |
| Users | `GET /users/directory` · admin: `GET/POST /users` · `GET/PUT /users/:id` · `PUT /users/:id/reset-password` |
| Settings | `GET/POST /lookups` · `PUT /lookups/:id` · `GET/POST /financial-years` · `GET /financial-years/current` · `PUT /financial-years/:id` · `PUT /financial-years/:id/set-current` · `GET/POST /workflow-stages` · `PUT /workflow-stages/:id` |
| Budget lines | `GET/POST /budget-lines` · `GET/PUT/DELETE /budget-lines/:id` · `PUT/DELETE /budget-lines/:id/allocations/:fyId` |
| Procurements | `GET/POST /procurements` · `GET/PUT/DELETE /procurements/:id` · `POST /procurements/:id/stages` · `DELETE /procurements/:id/stages/:eventId` |
| Tasks | `GET/POST /tasks` · `PUT/DELETE /tasks/:id` |
| Contracts | `GET/POST /contracts` · `GET/PUT/DELETE /contracts/:id` |
| Invoices | `GET/POST /invoices` · `GET/PUT/DELETE /invoices/:id` |
| Payments | `GET/POST /payments` · `DELETE /payments/:id` |
| Dashboard | `GET /dashboard/summary`, `budget-by-category`, `quarterly-spend`, `pipeline`, `stage-durations`, `officer-workload`, `invoice-ageing`, `expiring-contracts`, `attention`, `year-comparison` (filters: `fy_id`, `category_id`, `owner_id`) |
| Audit | admin: `GET /audit-logs` · `GET /audit-logs/auth-events` |
| Monitoring | `GET /metrics` (outside `/api`; Prometheus format) |

Responses look like `{ success: true, data, pagination? }` or `{ success: false, error, details? }`.

## Key business rules

- **Financial years are data.** Add a row for each new year; nothing is hard-coded. The quarters are Kenyan FY quarters: Q1 = Jul–Sep … Q4 = Apr–Jun.
- **Recording a step** (`POST /procurements/:id/stages`) moves the item:
  - *Approved/Completed* moves it to the next step.
  - Any other status keeps it at that step.
  - **Overdue** means the item has spent more days at its current step than that step's `sla_days`.
- **Budget:** planned amounts across years cannot exceed the line total (qty × unit price).
- **Money flow:**
  - Total invoices cannot exceed the contract value.
  - Only *Approved* invoices can be paid.
  - Payments cannot exceed the invoice amount.
  - An invoice becomes *Paid* automatically once it's fully paid.
