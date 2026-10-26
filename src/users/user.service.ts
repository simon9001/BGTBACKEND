import sql from 'mssql';
import { getDbPool, withTransaction } from '../db/dbconfig.js';
import { writeAudit } from '../audit/audit.service.js';
import type { AuthUser } from '../types/hono.js';
import type { CreateUserInput, UpdateUserInput } from '../validators/user.validators.js';

/**
 * Users service - all SQL for the Users table.
 * password_hash is never returned except by `getUserWithPasswordByEmailService`,
 * which is only used by the login flow.
 */

export interface User extends AuthUser {
    phone_number: string | null;
    is_active: boolean;
    last_login_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

// Columns that are safe to send to the client
const PUBLIC_COLUMNS = `user_id, full_name, email, phone_number, role, is_active, last_login_at, created_at, updated_at`;

// Get all users (active first, then by name)
export const getAllUsersService = async (): Promise<User[]> => {
    const db = getDbPool();
    const result = await db.request()
        .query(`SELECT ${PUBLIC_COLUMNS} FROM dbo.Users ORDER BY is_active DESC, full_name`);
    return result.recordset;
};

// Active users, minimal fields - for dropdowns and filters
export const getUserDirectoryService = async (): Promise<Pick<User, 'user_id' | 'full_name' | 'role'>[]> => {
    const db = getDbPool();
    const result = await db.request()
        .query(`SELECT user_id, full_name, role FROM dbo.Users WHERE is_active = 1 ORDER BY full_name`);
    return result.recordset;
};

// Get one user by id
export const getUserByIdService = async (userId: number): Promise<User | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('user_id', sql.Int, userId)
        .query(`SELECT ${PUBLIC_COLUMNS} FROM dbo.Users WHERE user_id = @user_id`);
    return result.recordset[0] ?? null;
};

// Get an active user in the shape stored on the request context (used by requireAuth)
export const getActiveUserByIdService = async (userId: number): Promise<AuthUser | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('user_id', sql.Int, userId)
        .query(`SELECT user_id, full_name, email, role FROM dbo.Users WHERE user_id = @user_id AND is_active = 1`);
    return result.recordset[0] ?? null;
};

// Get a user including password hash (login only)
export const getUserWithPasswordByEmailService = async (email: string) => {
    const db = getDbPool();
    const result = await db.request()
        .input('email', sql.NVarChar(150), email)
        .query(`SELECT user_id, full_name, email, role, is_active, password_hash FROM dbo.Users WHERE email = @email`);
    return (result.recordset[0] ?? null) as (AuthUser & { is_active: boolean; password_hash: string }) | null;
};

// Get only the password hash for a user (change-password flow)
export const getPasswordHashService = async (userId: number): Promise<string | null> => {
    const db = getDbPool();
    const result = await db.request()
        .input('user_id', sql.Int, userId)
        .query(`SELECT password_hash FROM dbo.Users WHERE user_id = @user_id`);
    return result.recordset[0]?.password_hash ?? null;
};

// Record a successful login
export const touchLastLoginService = async (userId: number): Promise<void> => {
    const db = getDbPool();
    await db.request()
        .input('user_id', sql.Int, userId)
        .query(`UPDATE dbo.Users SET last_login_at = SYSUTCDATETIME() WHERE user_id = @user_id`);
};

// Create a user (password must already be hashed)
export const createUserService = async (
    input: Omit<CreateUserInput, 'password'> & { password_hash: string },
    actorId: number,
): Promise<User> => {
    return withTransaction(async (tx) => {
        const result = await new sql.Request(tx)
            .input('full_name', sql.NVarChar(150), input.full_name)
            .input('email', sql.NVarChar(150), input.email)
            .input('phone_number', sql.NVarChar(20), input.phone_number ?? null)
            .input('role', sql.NVarChar(20), input.role)
            .input('password_hash', sql.NVarChar(255), input.password_hash)
            .query(`INSERT INTO dbo.Users (full_name, email, phone_number, role, password_hash)
                    OUTPUT ${PUBLIC_COLUMNS.split(', ').map((col) => `INSERTED.${col}`).join(', ')}
                    VALUES (@full_name, @email, @phone_number, @role, @password_hash)`);

        const user: User = result.recordset[0];
        await writeAudit(tx, { userId: actorId, action: 'CREATE', entity: 'Users', entityId: user.user_id, newValues: user });
        return user;
    });
};

// Update a user's profile / role / active flag. Only provided fields change.
export const updateUserService = async (userId: number, input: UpdateUserInput, actorId: number): Promise<User | null> => {
    const before = await getUserByIdService(userId);
    if (!before) return null;

    return withTransaction(async (tx) => {
        await new sql.Request(tx)
            .input('user_id', sql.Int, userId)
            .input('full_name', sql.NVarChar(150), input.full_name ?? before.full_name)
            .input('email', sql.NVarChar(150), input.email ?? before.email)
            .input('phone_number', sql.NVarChar(20), input.phone_number === undefined ? before.phone_number : input.phone_number)
            .input('role', sql.NVarChar(20), input.role ?? before.role)
            .input('is_active', sql.Bit, input.is_active ?? before.is_active)
            .query(`UPDATE dbo.Users
                    SET full_name = @full_name, email = @email, phone_number = @phone_number,
                        role = @role, is_active = @is_active, updated_at = SYSUTCDATETIME()
                    WHERE user_id = @user_id`);

        const after = (await new sql.Request(tx)
            .input('user_id', sql.Int, userId)
            .query(`SELECT ${PUBLIC_COLUMNS} FROM dbo.Users WHERE user_id = @user_id`)).recordset[0] as User;

        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Users', entityId: userId, oldValues: before, newValues: after });
        return after;
    });
};

// Replace a user's password hash (change-password and admin reset)
export const updatePasswordService = async (userId: number, passwordHash: string, actorId: number): Promise<void> => {
    await withTransaction(async (tx) => {
        await new sql.Request(tx)
            .input('user_id', sql.Int, userId)
            .input('password_hash', sql.NVarChar(255), passwordHash)
            .query(`UPDATE dbo.Users SET password_hash = @password_hash, updated_at = SYSUTCDATETIME() WHERE user_id = @user_id`);

        // never store password hashes in the audit log
        await writeAudit(tx, { userId: actorId, action: 'UPDATE', entity: 'Users', entityId: userId, newValues: { password: 'changed' } });
    });
};
