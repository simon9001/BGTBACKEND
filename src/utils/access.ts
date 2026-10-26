import type { AuthUser } from '../types/hono.js';
import { securityLogger } from '../logger/logger.js';
import { authDeniedTotal } from '../metrics/metrics.js';
import { HttpError } from './http-error.js';
import { currentRequestMeta } from './request-context.js';

/**
 * Row-level access rules.
 *
 *   admin   -> may edit any record
 *   officer -> may edit only records they own
 *   viewer  -> may not edit anything (also blocked at route level)
 */

/** True when the user may modify a record owned by `ownerId`. */
export const canEdit = (user: AuthUser, ownerId: number): boolean =>
    user.role === 'admin' || (user.role === 'officer' && user.user_id === ownerId);

/** Throws 403 (and records a security event) when the user may not modify a record owned by `ownerId`. */
export const assertCanEdit = (user: AuthUser, ownerId: number): void => {
    if (!canEdit(user, ownerId)) {
        authDeniedTotal.inc({ reason: 'not_owner' });
        securityLogger.warn(
            { user_id: user.user_id, user_role: user.role, owner_id: ownerId, ...currentRequestMeta() },
            'Permission denied: tried to modify an item owned by someone else',
        );
        throw new HttpError(403, 'You can only modify items that are assigned to you');
    }
};
