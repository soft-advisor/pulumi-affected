/** Runs `task` on each item with at most `limit` running at once, keeping the input order */
export async function mapConcurrently<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
) {
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error(`concurrency must be at least 1, not ${limit}`);
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
