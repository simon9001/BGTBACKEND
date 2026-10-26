/**
 * Shared Hono types.
 *
 * Every router is created as `new Hono<AppEnv>()`, so `c.get('user')` is
 * fully typed in controllers after the auth middleware has run.
 */

export type UserRole = 'admin' | 'officer' | 'viewer';

/** The logged-in user, attached to the request context by `requireAuth`. */
export interface AuthUser {
    user_id: number;
    full_name: string;
    email: string;
    role: UserRole;
}

export interface AppEnv {
    Variables: {
        user: AuthUser;      // set by requireAuth
        requestId: string;   // set by the requestId middleware, returned as X-Request-Id
    };
}
