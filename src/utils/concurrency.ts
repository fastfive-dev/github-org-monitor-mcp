export interface ConcurrentResult<R> {
  results: (R | null)[];
  errors: { index: number; item: string; error: string }[];
}

/**
 * Run async tasks with bounded concurrency.
 * Returns results in the same order as the input, collecting failures.
 */
export async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R | null>,
  concurrency = 5,
  itemLabel?: (item: T) => string
): Promise<ConcurrentResult<R>> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  const errors: { index: number; item: string; error: string }[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        results[i] = null;
        errors.push({
          index: i,
          item: itemLabel ? itemLabel(items[i]) : String(i),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);
  return { results, errors };
}
