import * as userServices from '../users/user.service.js';

/**
 * Auth service.
 * Thin layer over the users service so the auth flow reads clearly and the
 * SQL for the Users table lives in one place (users/user.service.ts).
 */

// Look up a user by email, including the password hash, for login
export const findUserForLoginService = (email: string) =>
    userServices.getUserWithPasswordByEmailService(email);

// Stamp last_login_at after a successful login
export const recordLoginService = (userId: number) =>
    userServices.touchLastLoginService(userId);

// Current password hash, to verify before changing it
export const getPasswordHashService = (userId: number) =>
    userServices.getPasswordHashService(userId);

// A user changing their own password
export const changePasswordService = (userId: number, passwordHash: string) =>
    userServices.updatePasswordService(userId, passwordHash, userId);
