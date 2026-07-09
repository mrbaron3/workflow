/**
 * A bounded-concurrency map: run `fn` over `items` with at most `limit` in flight at once —
 * a saturation guard for machine / rate limits. Two consumers share it: the panel's reviewer
 * fan-out (ADR-0006 E4, panel.maxConcurrent) and the live turn's issue dispatch (FEAT-008,
 * maxConcurrentIssues). Results keep input order regardless of completion order. A worker
 * that throws rejects the whole call (the caller decides how to surface it); it does not
 * silently drop an item.
 */
export async function mapPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  const bound = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: bound }, () => worker()));
  return results;
}
