import type { Context, Next } from 'hono';
import { verify } from 'hono/jwt';
import { env } from '../config/env.js';
import type { AppEnv, UserRole } from '../types/hono.js';
import { getActiveUserByIdService } from '../users/user.service.js';
import { securityLogger } from '../logger/logger.js';
import { authDeniedTotal } from '../metrics/metrics.js';
import { clientIp } from '../utils/request-context.js';

/**
 * Authentication & authorization middleware.
 *
 *   requireAuth          -> request must carry a valid "Bearer <token>" header
 *   requireRole(...)     -> logged-in user must have one of the given roles
 *
 * Usage in a routes file:
 *   routes.use('/budget-lines/*', requireAuth);
 *   routes.post('/budget-lines', requireRole('admin', 'officer'), controller.create);
 */

/** Payload we sign into the JWT at login (see auth.controller.ts). */
export interface TokenPayload {
    sub: number;      // user_id
    role: UserRole;
    exp: number;      // expiry (seconds since epoch)
    [key: string]: unknown;
}

/**
 * Verifies the JWT and loads the user from the database.
 * Loading the user on every request means a deactivated account or a changed
 * role takes effect immediately, not only when the token expires.
 */
export const requireAuth = async (c: Context<AppEnv>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader?.startsWith('Bearer ')) {
        authDeniedTotal.inc({ reason: 'missing_token' });
        return c.json({ success: false, error: 'Authorization header with Bearer token is required' }, 401);
    }

    const token = authHeader.slice('Bearer '.length);

    let payload: TokenPayload;
    try {
        payload = (await verify(token, env.JWT_SECRET, 'HS256')) as unknown as TokenPayload;
    } catch (err) {
        // Expired tokens are routine; anything else (bad signature, garbage) is suspicious
        const expired = (err as Error)?.name === 'JwtTokenExpired';
        authDeniedTotal.inc({ reason: expired ? 'expired_token' : 'invalid_token' });
        if (!expired) {
            securityLogger.warn({ ...denialContext(c), error: (err as Error)?.message }, 'Rejected an invalid token');
        }
        return c.json({ success: false, error: 'Invalid or expired token' }, 401);
    }

    const user = await getActiveUserByIdService(Number(payload.sub));
    if (!user) {
        authDeniedTotal.inc({ reason: 'inactive_user' });
        securityLogger.warn({ ...denialContext(c), user_id: Number(payload.sub) }, 'Valid token used by a missing or deactivated account');
        return c.json({ success: false, error: 'Account not found or deactivated' }, 401);
    }

    c.set('user', user);
    await next();
};

/**
 * Allows the request only if the logged-in user has one of `roles`.
 * Must run after `requireAuth`.
 */
export const requireRole = (...roles: UserRole[]) => {
    return async (c: Context<AppEnv>, next: Next) => {
        const user = c.get('user');
        if (!user || !roles.includes(user.role)) {
            authDeniedTotal.inc({ reason: 'forbidden_role' });
            securityLogger.warn(
                { ...denialContext(c), user_id: user?.user_id, user_role: user?.role, required_roles: roles },
                'Permission denied: role not allowed',
            );
            return c.json({ success: false, error: 'You do not have permission to perform this action' }, 403);
        }
        await next();
    };
};

// Common fields for security log lines about refused requests
const denialContext = (c: Context<AppEnv>) => ({
    request_id: c.get('requestId'),
    method: c.req.method,
    path: c.req.path,
    ip: clientIp(c),
});

/** Shortcuts for the most common rules. */
export const adminOnly = requireRole('admin');
export const canWrite = requireRole('admin', 'officer'); // viewers are read-only
