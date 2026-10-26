import type { Context } from 'hono';
import bcrypt from 'bcryptjs';
import { sign } from 'hono/jwt';
import { env } from '../config/env.js';
import type { AppEnv } from '../types/hono.js';
import type { TokenPayload } from '../middleware/bearAuth.js';
import { validateBody } from '../middleware/validation.js';
import { ChangePasswordSchema, LoginSchema } from '../validators/user.validators.js';
import { HttpError } from '../utils/http-error.js';
import { recordAuthEvent } from '../audit/audit.service.js';
import { authLoginsTotal } from '../metrics/metrics.js';
import * as authServices from './auth.service.js';

/**
 * Auth controller.
 * There is no public registration - the Head of ICT creates staff accounts.
 */

// POST /api/auth/login
export const login = async (c: Context<AppEnv>) => {
    const { email, password } = await validateBody(c, LoginSchema);

    const user = await authServices.findUserForLoginService(email);

    // Same message for "no such user" and "wrong password" so emails cannot be
    // probed - the real reason is kept in the audit record only.
    const passwordOk = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!user || !passwordOk) {
        const reason = user ? 'wrong_password' : 'unknown_email';
        await recordAuthEvent({ eventType: 'LOGIN_FAILED', userId: user?.user_id ?? null, email, reason });
        authLoginsTotal.inc({ result: 'invalid_credentials' });
        throw new HttpError(401, 'Invalid email or password');
    }
    if (!user.is_active) {
        await recordAuthEvent({ eventType: 'LOGIN_FAILED', userId: user.user_id, email, reason: 'account_deactivated' });
        authLoginsTotal.inc({ result: 'deactivated' });
        throw new HttpError(403, 'Your account has been deactivated. Contact the Head of ICT.');
    }

    const expiresInSeconds = Math.round(env.JWT_EXPIRES_IN_HOURS * 60 * 60);
    const payload: TokenPayload = {
        sub: user.user_id,
        role: user.role,
        exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    };
    const token = await sign(payload, env.JWT_SECRET, 'HS256');

    await authServices.recordLoginService(user.user_id);
    await recordAuthEvent({ eventType: 'LOGIN_SUCCESS', userId: user.user_id, email });
    authLoginsTotal.inc({ result: 'success' });

    return c.json({
        success: true,
        message: 'Login successful',
        data: {
            token,
            expires_in: expiresInSeconds,
            user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role },
        },
    });
};

// GET /api/auth/me - the logged-in user's profile
export const me = async (c: Context<AppEnv>) => {
    return c.json({ success: true, data: c.get('user') });
};

// PUT /api/auth/change-password
export const changePassword = async (c: Context<AppEnv>) => {
    const { current_password, new_password } = await validateBody(c, ChangePasswordSchema);
    const user = c.get('user');

    const currentHash = await authServices.getPasswordHashService(user.user_id);
    if (!currentHash || !(await bcrypt.compare(current_password, currentHash))) {
        throw new HttpError(400, 'Current password is incorrect');
    }

    await authServices.changePasswordService(user.user_id, await bcrypt.hash(new_password, 10));
    await recordAuthEvent({ eventType: 'PASSWORD_CHANGED', userId: user.user_id, email: user.email });
    return c.json({ success: true, message: 'Password changed successfully' });
};
