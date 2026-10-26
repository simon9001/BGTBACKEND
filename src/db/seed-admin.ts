import bcrypt from 'bcryptjs';
import sql from 'mssql';
import initDatabaseConnection, { closeDatabaseConnection } from './dbconfig.js';

/**
 * Creates the first Head of ICT (admin) account.
 *
 *   pnpm db:seed-admin -- "Full Name" email@kenha.co.ke "StrongPassword1"
 *
 * There is no public registration in this app: the admin logs in and creates
 * accounts for the ICT officers from the Users screen.
 */

const [fullName, email, password] = process.argv.slice(2).filter((arg) => arg !== '--');

const run = async () => {
    if (!fullName || !email || !password) {
        throw new Error('Usage: pnpm db:seed-admin -- "Full Name" email@example.com "Password"');
    }
    if (password.length < 8) {
        throw new Error('Password must be at least 8 characters');
    }

    const pool = await initDatabaseConnection();

    const existing = await pool.request()
        .input('email', sql.NVarChar(150), email.toLowerCase())
        .query('SELECT user_id FROM dbo.Users WHERE email = @email');

    if (existing.recordset.length > 0) {
        console.log(`ℹ A user with email ${email} already exists - nothing to do.`);
        return;
    }

    const passwordHash = await bcrypt.hash(password, 10);

    await pool.request()
        .input('full_name', sql.NVarChar(150), fullName)
        .input('email', sql.NVarChar(150), email.toLowerCase())
        .input('password_hash', sql.NVarChar(255), passwordHash)
        .query(`INSERT INTO dbo.Users (full_name, email, password_hash, role)
                VALUES (@full_name, @email, @password_hash, 'admin')`);

    console.log(`✅ Admin account created for ${email}`);
};

run()
    .catch((error) => {
        console.error('❌ Failed to create admin:', error.message ?? error);
        process.exitCode = 1;
    })
    .finally(closeDatabaseConnection);
