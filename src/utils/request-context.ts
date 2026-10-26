import type { Context } from 'hono';
import { getContext } from 'hono/context-storage';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { AppEnv } from '../types/hono.js';

/**
 * Access to "who / where / which request" from anywhere in the code.
 *
 * Services do not receive the Hono context, but audit records and security
 * logs need the request id and client IP. Hono's `contextStorage()` middleware
 * (registered in index.ts) keeps the current context in AsyncLocalStorage,
 * so these helpers can read it without passing it through every function.
 */

export interface RequestMeta {
    request_id: string | null;
    ip_address: string | null;
    user_agent: string | null;
}

/** Client IP address of a request. */
export const clientIp = (c: Context): string => getConnInfo(c).remote.address ?? 'unknown';

/**
 * Request id, IP and user agent of the request being handled.
 * Returns nulls when called outside a request (e.g. from a CLI script).
 */
export const currentRequestMeta = (): RequestMeta => {
    try {
        const c = getContext<AppEnv>();
        return {
            request_id: c.get('requestId') ?? null,
            ip_address: clientIp(c),
            user_agent: c.req.header('user-agent')?.slice(0, 400) ?? null,
        };
    } catch {
        return { request_id: null, ip_address: null, user_agent: null };
    }
};
