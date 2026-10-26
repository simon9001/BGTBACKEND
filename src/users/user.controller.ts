import type { Context } from 'hono';
import bcrypt from 'bcryptjs';
import type { AppEnv } from '../types/hono.js';
import { validateBody, validateIdParam } from '../middleware/validation.js';
import { CreateUserSchema, ResetPasswordSchema, UpdateUserSchema } from '../validators/user.validators.js';
import { HttpError } from '../utils/http-error.js';
import { recordAuthEvent } from '../audit/audit.service.js';
import * as userServices from './user.service.js';

/**
 * Users controller - staff account management (Head of ICT only).
 * Accounts are deactivated, never deleted, so their history stays intact.
 */

// GET /api/users
export const getAllUsers = async (c: Context<AppEnv>) => {
    const users = await userServices.getAllUsersService();
    return c.json({ success: true, data: users });
};

// GET /api/users/directory
export const getUserDirectory = async (c: Context<AppEnv>) => {
    const users = await userServices.getUserDirectoryService();
    return c.json({ success: true, data: users });
};

// GET /api/users/:id
export const getUserById = async (c: Context<AppEnv>) => {
    const userId = validateIdParam(c, 'id');
    const user = await userServices.getUserByIdService(userId);
    if (!user) throw new HttpError(404, 'User not found');
    return c.json({ success: true, data: user });
};

// POST /api/users
export const createUser = async (c: Context<AppEnv>) => {
    const { password, ...input } = await validateBody(c, CreateUserSchema);
    const password_hash = await bcrypt.hash(password, 10);

    const user = await userServices.createUserService({ ...input, password_hash }, c.get('user').user_id);
    return c.json({ success: true, message: 'User created successfully', data: user }, 201);
};

// PUT /api/users/:id
export const updateUser = async (c: Context<AppEnv>) => {
    const userId = validateIdParam(c, 'id');
    const input = await validateBody(c, UpdateUserSchema);
    const actor = c.get('user');

    // Stop the Head of ICT from locking themselves out by accident
    if (userId === actor.user_id && (input.is_active === false || (input.role && input.role !== 'admin'))) {
        throw new HttpError(400, 'You cannot deactivate your own account or remove your own admin role');
    }

    const user = await userServices.updateUserService(userId, input, actor.user_id);
    if (!user) throw new HttpError(404, 'User not found');
    return c.json({ success: true, message: 'User updated successfully', data: user });
};

// PUT /api/users/:id/reset-password
export const resetPassword = async (c: Context<AppEnv>) => {
    const userId = validateIdParam(c, 'id');
    const { new_password } = await validateBody(c, ResetPasswordSchema);

    const user = await userServices.getUserByIdService(userId);
    if (!user) throw new HttpError(404, 'User not found');

    await userServices.updatePasswordService(userId, await bcrypt.hash(new_password, 10), c.get('user').user_id);
    await recordAuthEvent({ eventType: 'PASSWORD_RESET', userId, email: user.email, reason: `reset by user ${c.get('user').user_id}` });
    return c.json({ success: true, message: 'Password reset successfully' });
};
