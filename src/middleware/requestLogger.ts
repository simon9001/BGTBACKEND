import type { Context, Next } from 'hono';
import type { AppEnv } from '../types/hono.js';
import { httpLogger } from '../logger/logger.js';
import { clientIp } from '../utils/request-context.js';

/**
 * Writes one "http" log line per request, after the response is ready:
 *
 *   { request_id, method, path, route, status, duration_ms, user_id, user_role, ip, user_agent }
 *
 * Level follows the outcome: 5xx = error, 4xx = warn, otherwise info.
 * Prometheus scrapes of /metrics are logged at debug to keep the files readable.
 * Request bodies are never logged (they may contain passwords or personal data).
 */
export const requestLogger = async (c: Context<AppEnv>, next: Next) => {
    const startedAt = performance.now();
    await next();

    const status = c.res.status;
    const user = c.get('user') as AppEnv['Variables']['user'] | undefined; // only set on authenticated routes

    const entry = {
        request_id: c.get('requestId'),
        method: c.req.method,
        path: c.req.path,
        route: c.req.routePath,
        status,
        duration_ms: Math.round((performance.now() - startedAt) * 10) / 10,
        user_id: user?.user_id ?? null,
        user_role: user?.role ?? null,
        ip: clientIp(c),
        user_agent: c.req.header('user-agent') ?? null,
    };
    const message = `${entry.method} ${entry.path} ${status} ${entry.duration_ms}ms`;

    if (c.req.path === '/metrics') httpLogger.debug(entry, message);
    else if (status >= 500) httpLogger.error(entry, message);
    else if (status >= 400) httpLogger.warn(entry, message);
    else httpLogger.info(entry, message);
};
