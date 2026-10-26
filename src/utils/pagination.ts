/**
 * Pagination helpers shared by list endpoints.
 * List queries use SQL Server's OFFSET ... FETCH NEXT ... ROWS ONLY.
 */

export interface Pagination {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
}

/** Number of rows to skip for a given page (pages start at 1). */
export const toOffset = (page: number, limit: number): number => (page - 1) * limit;

/** Builds the pagination block returned alongside list results. */
export const buildPagination = (page: number, limit: number, total: number): Pagination => ({
    page,
    limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / limit)),
});
