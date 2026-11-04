import 'dotenv/config';
import { z } from 'zod';

/**
 * Environment configuration.
 *
 * All environment variables are read and validated ONCE here, at startup.
 * The rest of the app imports `env` instead of touching `process.env`, so a
 * missing or malformed variable fails fast with a clear message.
 */

// "true"/"false" strings from .env -> boolean
const booleanString = z
    .enum(['true', 'false'])
    .transform((value) => value === 'true');

const EnvSchema = z.object({
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    // Comma separated list of allowed frontend origins, e.g. "http://localhost:5173"
    CORS_ORIGIN: z.string().default('http://localhost:5173'),

    // SQL Server connection
    SQL_SERVER: z.string().min(1, 'SQL_SERVER is required'),
    SQL_PORT: z.coerce.number().int().positive().default(1433),
    SQL_DATABASE: z.string().min(1, 'SQL_DATABASE is required'),
    SQL_USER: z.string().min(1, 'SQL_USER is required'),
    SQL_PASSWORD: z.string().min(1, 'SQL_PASSWORD is required'),
    SQL_ENCRYPT: booleanString.default(false),
    SQL_TRUST_SERVER_CERTIFICATE: booleanString.default(true),

    // Authentication
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN_HOURS: z.coerce.number().positive().default(8),

    // Set to "true" only behind a reverse proxy (IIS, nginx), which passes the real
    // client address in X-Forwarded-For. Without a proxy this header can be forged.
    TRUST_PROXY: booleanString.default(false),

    // API requests allowed per user address in 15 minutes
    API_RATE_LIMIT: z.coerce.number().int().positive().default(5000),

    // Logging
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    LOG_DIR: z.string().default('logs'),
    LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(90),

    // Prometheus: token the scraper must send as "Authorization: Bearer <token>".
    // If unset, /metrics is open in development and disabled in production.
    METRICS_TOKEN: z.string().min(16, 'METRICS_TOKEN must be at least 16 characters').optional(),
});

const parsed = EnvSchema.safeParse(process.env);

if (!parsed.success) {
    console.error('❌ Invalid environment configuration:');
    for (const issue of parsed.error.issues) {
        console.error(`   - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
}

export const env = parsed.data;

// Settings that work on a developer's machine but should not reach a live server.
// A warning, not a stop, so a test run with NODE_ENV=production still starts.
if (env.NODE_ENV === 'production') {
    const problems = [
        env.CORS_ORIGIN.includes('localhost') && 'CORS_ORIGIN still points at localhost',
        !env.METRICS_TOKEN && 'METRICS_TOKEN is not set, so /metrics is disabled',
        !env.SQL_ENCRYPT && 'SQL_ENCRYPT is false: only acceptable when SQL Server is on the same machine',
    ].filter(Boolean);
    for (const problem of problems) console.warn(`Production setting to check: ${problem}`);
}
