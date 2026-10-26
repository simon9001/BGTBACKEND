import type { ContentfulStatusCode } from 'hono/utils/http-status';

/**
 * An error that maps directly to an HTTP response.
 *
 * Throw it from controllers or services; the global error handler in index.ts
 * turns it into `{ success: false, error, details }` with the given status.
 * This keeps controllers free of repetitive try/catch blocks.
 */
export class HttpError extends Error {
    constructor(
        public readonly status: ContentfulStatusCode,
        message: string,
        public readonly details?: unknown,
    ) {
        super(message);
        this.name = 'HttpError';
    }
}

// SQL Server error numbers we translate into friendly HTTP errors
const SQL_UNIQUE_VIOLATION = [2627, 2601];
const SQL_FOREIGN_KEY_OR_CHECK_VIOLATION = 547;

/**
 * Converts known SQL Server constraint errors into HttpErrors.
 * Returns null for anything else (which becomes a 500).
 */
export const fromSqlError = (error: unknown): HttpError | null => {
    const number = (error as { number?: number })?.number;

    if (number !== undefined && SQL_UNIQUE_VIOLATION.includes(number)) {
        return new HttpError(409, 'A record with the same unique value already exists');
    }
    if (number === SQL_FOREIGN_KEY_OR_CHECK_VIOLATION) {
        return new HttpError(400, 'The request references a record that does not exist, or breaks a data rule');
    }
    return null;
};
