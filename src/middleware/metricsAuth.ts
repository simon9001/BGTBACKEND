import { timingSafeEqual } from 'node:crypto';
import type { Context, Next } from 'hono';
import { env } from '../config/env.js';
import { securityLogger } from '../logger/logger.js';
import { clientIp } from '../utils/request-context.js';

/**
 * Protects GET /metrics.
 *
 *   METRICS_TOKEN set      -> caller must send "Authorization: Bearer <METRICS_TOKEN>"
 *   unset, development     -> open (convenient while building)
 *   unset, production      -> disabled (404), so metrics are never exposed by accident
 */

// Constant-time comparison so the token cannot be guessed by timing responses
const tokensMatch = (given: string, expected: string): boolean => {
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
};

export const metricsAuth = async (c: Context, next: Next) => {
    if (!env.METRICS_TOKEN) {
        if (env.NODE_ENV === 'production') {
            return c.json({ success: false, error: 'Route not found' }, 404);
        }
        return next();
    }

    const header = c.req.header('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

    if (!tokensMatch(token, env.METRICS_TOKEN)) {
        securityLogger.warn({ ip: clientIp(c) }, 'Rejected /metrics request with a missing or wrong token');
        return c.json({ success: false, error: 'Unauthorized' }, 401);
    }
    await next();
};
