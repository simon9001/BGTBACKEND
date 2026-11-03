import bcrypt from 'bcryptjs';
import sql from 'mssql';
import initDatabaseConnection, { closeDatabaseConnection } from './dbconfig.js';

/**
 * Sets up the system administrator, who manages user accounts.
 *
 *   pnpm db:seed-sa -- email@kenha.co.ke                            (existing account)
 *   pnpm db:seed-sa -- email@kenha.co.ke "Full Name" "StrongPass1"  (new account)
 */

const [email, fullName, password] = process.argv.slice(2).filter((arg) => arg !== '--');

const run = async () => {
    if (!email) {
        throw new Error('Usage: pnpm db:seed-sa -- email@example.com ["Full Name" "Password"]');
    }

    const pool = await initDatabaseConnection();

    const existing = await pool.request()
        .input('email', sql.NVarChar(150), email.toLowerCase())
        .query('SELECT user_id FROM dbo.Users WHERE email = @email');

    if (existing.recordset.length > 0) {
        await pool.request()
            .input('user_id', sql.Int, existing.recordset[0].user_id)
            .query(`UPDATE dbo.Users SET role = 'sa', updated_at = SYSUTCDATETIME() WHERE user_id = @user_id`);
        console.log(`✅ ${email} is now the system administrator`);
        return;
    }

    if (!fullName || !password) {
        throw new Error(`No account uses ${email}. To create one: pnpm db:seed-sa -- ${email} "Full Name" "Password"`);
    }
    if (password.length < 8) {
        throw new Error('Password must be at least 8 characters');
    }

    await pool.request()
        .input('full_name', sql.NVarChar(150), fullName)
        .input('email', sql.NVarChar(150), email.toLowerCase())
        .input('password_hash', sql.NVarChar(255), await bcrypt.hash(password, 10))
        .query(`INSERT INTO dbo.Users (full_name, email, password_hash, role)
                VALUES (@full_name, @email, @password_hash, 'sa')`);

    console.log(`✅ System administrator account created for ${email}`);
};

run()
    .catch((error) => {
        console.error('❌ Failed to set up the system administrator:', error.message ?? error);
        process.exitCode = 1;
    })
    .finally(closeDatabaseConnection);
