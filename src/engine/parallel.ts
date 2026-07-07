/** Map with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Default fan-out width for parallel claude calls. */
export function defaultConcurrency(): number {
  const fromEnv = Number(process.env.FABEL_CONCURRENCY);
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv;
  return 4;
}
