import { rateLimiter } from 'hono-rate-limiter';
import { env } from '../config/env.js';
import { clientIp } from '../utils/request-context.js';

/**
 * Rate limiters (in-memory store - fine for a single department server).
 *
 * The API limit is keyed by client IP address, and the login limit by address
 * and email together: staff in one office can share an address, and one person
 * mistyping a password must not lock out everyone else.
 */

/** Applied to every /api route: generous limit to stop runaway clients. */
export const apiLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: env.API_RATE_LIMIT,
    standardHeaders: 'draft-6',
    keyGenerator: clientIp,
});

/** Applied to the login route: slows down password guessing. */
export const loginLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: 'draft-6',
    keyGenerator: async (c) => {
        const body = await c.req.json().catch(() => null) as { email?: unknown } | null;
        return `${clientIp(c)}:${String(body?.email ?? '').trim().toLowerCase()}`;
    },
    message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});
