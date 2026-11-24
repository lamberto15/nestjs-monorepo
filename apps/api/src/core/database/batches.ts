/** Rows deleted per statement by a sweep: short transactions, short locks. */
export const DELETE_BATCH = 5_000;

/**
 * Runs `deleteBatch(limit)` until it deletes fewer than `limit` rows, and
 * returns how many went in all: the loop of every sweep that deletes by age
 * (retention jobs), so a big backlog never becomes one long statement.
 */
export async function deleteInBatches(
  deleteBatch: (limit: number) => Promise<number>,
  limit = DELETE_BATCH,
): Promise<number> {
  let total = 0;
  for (;;) {
    const deleted = await deleteBatch(limit);
    total += deleted;
    if (deleted < limit) return total;
  }
}
