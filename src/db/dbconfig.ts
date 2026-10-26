import sql from 'mssql';
import { env } from '../config/env.js';
import { dbLogger } from '../logger/logger.js';

/**
 * MSSQL database configuration and connection pool.
 *
 * A single connection pool is created at startup and shared by every service.
 * Services call `getDbPool()` to run queries; they never open their own
 * connections.
 */

export const sqlConfig: sql.config = {
    user: env.SQL_USER,
    password: env.SQL_PASSWORD,
    server: env.SQL_SERVER,
    port: env.SQL_PORT,
    database: env.SQL_DATABASE,
    connectionTimeout: 15000,
    requestTimeout: 30000,
    pool: {
        max: 10,
        min: 0,
        idleTimeoutMillis: 30000,
    },
    options: {
        encrypt: env.SQL_ENCRYPT,
        trustServerCertificate: env.SQL_TRUST_SERVER_CERTIFICATE,
        enableArithAbort: true,
    },
};

let globalPool: sql.ConnectionPool | null = null;

/**
 * Opens the shared connection pool (or returns it if already open).
 * Called once from index.ts before the HTTP server starts.
 */
const initDatabaseConnection = async (): Promise<sql.ConnectionPool> => {
    if (globalPool?.connected) {
        return globalPool;
    }

    try {
        globalPool = await new sql.ConnectionPool(sqlConfig).connect();
        globalPool.on('error', (err) => dbLogger.error({ err }, 'Database pool error'));
        dbLogger.info({ server: env.SQL_SERVER, database: env.SQL_DATABASE }, 'Connected to MSSQL database');
        return globalPool;
    } catch (err) {
        dbLogger.fatal({ err, server: env.SQL_SERVER, database: env.SQL_DATABASE }, 'Database connection failed');
        throw err;
    }
};

/**
 * Returns the shared connection pool. Throws if the pool has not been opened.
 */
export const getDbPool = (): sql.ConnectionPool => {
    if (!globalPool?.connected) {
        throw new Error('Database not connected. Call initDatabaseConnection() first.');
    }
    return globalPool;
};

// Callbacks waiting for a transaction to commit (see afterCommit)
const commitCallbacks = new WeakMap<sql.Transaction, Array<() => void>>();

/**
 * Runs `work` inside a database transaction.
 * Commits if `work` resolves, rolls back if it throws, and re-throws the error.
 * Callbacks registered with `afterCommit` run only after a successful commit.
 *
 * @example
 *   await withTransaction(async (tx) => {
 *       await new sql.Request(tx).query('...');
 *   });
 */
export const withTransaction = async <T>(work: (tx: sql.Transaction) => Promise<T>): Promise<T> => {
    const tx = new sql.Transaction(getDbPool());
    commitCallbacks.set(tx, []);
    await tx.begin();
    try {
        const result = await work(tx);
        await tx.commit();
        for (const callback of commitCallbacks.get(tx) ?? []) callback();
        return result;
    } catch (error) {
        await tx.rollback();
        throw error;
    } finally {
        commitCallbacks.delete(tx);
    }
};

/**
 * Runs `callback` once the data is really saved:
 *   - inside withTransaction -> after the transaction commits (never on rollback)
 *   - with the plain pool    -> immediately
 * Used so audit logs and metrics never report changes that were rolled back.
 */
export const afterCommit = (executor: sql.ConnectionPool | sql.Transaction, callback: () => void): void => {
    const pending = executor instanceof sql.Transaction ? commitCallbacks.get(executor) : undefined;
    if (pending) pending.push(callback);
    else callback();
};

/** Closes the pool (used by scripts and graceful shutdown). */
export const closeDatabaseConnection = async (): Promise<void> => {
    await globalPool?.close();
    globalPool = null;
};

export default initDatabaseConnection;
