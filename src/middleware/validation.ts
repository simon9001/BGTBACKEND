import type { Context } from 'hono';
import { z } from 'zod';
import { HttpError } from '../utils/http-error.js';

/**
 * Request validation helpers.
 *
 * Controllers call these at the top of a handler to get fully-typed, validated
 * input. On failure they throw an HttpError(400) with a list of
 * { field, message } entries, which the global error handler returns.
 *
 * @example
 *   const body = await validateBody(c, CreateBudgetLineSchema);
 *   const id   = validateIdParam(c, 'id');
 */

// Converts zod issues into a compact, frontend-friendly list
const formatIssues = (error: z.ZodError) =>
    error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
    }));

/** Validates the JSON request body against `schema`. */
export const validateBody = async <T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> => {
    let body: unknown;
    try {
        body = await c.req.json();
    } catch {
        throw new HttpError(400, 'Request body must be valid JSON');
    }

    const result = schema.safeParse(body);
    if (!result.success) {
        throw new HttpError(400, 'Validation failed', formatIssues(result.error));
    }
    return result.data;
};

/** Validates the query string against `schema` (use z.coerce for numbers). */
export const validateQuery = <T extends z.ZodType>(c: Context, schema: T): z.infer<T> => {
    const result = schema.safeParse(c.req.query());
    if (!result.success) {
        throw new HttpError(400, 'Invalid query parameters', formatIssues(result.error));
    }
    return result.data;
};

/** Reads a route parameter and ensures it is a positive integer id. */
export const validateIdParam = (c: Context, name: string): number => {
    const id = Number(c.req.param(name));
    if (!Number.isInteger(id) || id <= 0) {
        throw new HttpError(400, `Route parameter "${name}" must be a positive integer`);
    }
    return id;
};
