import { rateLimiter } from 'hono-rate-limiter';
import { clientIp } from '../utils/request-context.js';

/**
 * Rate limiters (in-memory store - fine for a single department server).
 *
 * Requests are keyed by client IP address.
 */

/** Applied to every /api route: generous limit to stop runaway clients. */
export const apiLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 1000,
    standardHeaders: 'draft-6',
    keyGenerator: clientIp,
});

/** Applied to the login route: slows down password guessing. */
export const loginLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 10,
    standardHeaders: 'draft-6',
    keyGenerator: clientIp,
    message: { success: false, error: 'Too many login attempts. Try again in 15 minutes.' },
});
