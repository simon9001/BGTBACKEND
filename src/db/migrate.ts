import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import initDatabaseConnection, { closeDatabaseConnection } from './dbconfig.js';

/**
 * Database migration script.
 *
 *   pnpm db:migrate
 *
 * Runs schema.sql then seed.sql against the database configured in .env.
 * Both files are idempotent, so this is safe to run repeatedly.
 * SQL files are split on "GO" lines because GO is a client-side batch
 * separator understood by SSMS/sqlcmd, not by SQL Server itself.
 */

const dbDir = path.dirname(fileURLToPath(import.meta.url));
const files = ['schema.sql', 'seed.sql'];

// Split a script into batches on lines that contain only "GO"
const splitBatches = (script: string): string[] =>
    script
        .split(/^\s*GO\s*$/gim)
        .map((batch) => batch.trim())
        .filter((batch) => batch.length > 0);

const run = async () => {
    const pool = await initDatabaseConnection();

    for (const file of files) {
        const script = await readFile(path.join(dbDir, file), 'utf-8');
        const batches = splitBatches(script);
        console.log(`▶ Running ${file} (${batches.length} batches)`);

        for (const batch of batches) {
            await pool.request().batch(batch);
        }
    }

    console.log('✅ Migration complete');
};

run()
    .catch((error) => {
        console.error('❌ Migration failed:', error);
        process.exitCode = 1;
    })
    .finally(closeDatabaseConnection);
