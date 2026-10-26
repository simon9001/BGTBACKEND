/**
 * Money helpers.
 *
 * JavaScript numbers are floating point (0.1 + 0.2 !== 0.3), so amounts are
 * compared as whole cents. Totals stored in the database are always computed
 * in SQL with DECIMAL(18,2), which is exact.
 */

/** Converts an amount to integer cents. */
export const toCents = (amount: number): number => Math.round(amount * 100);

/** Sums amounts exactly (via cents) and returns the total in currency units. */
export const sumAmounts = (amounts: number[]): number =>
    amounts.reduce((total, amount) => total + toCents(amount), 0) / 100;
