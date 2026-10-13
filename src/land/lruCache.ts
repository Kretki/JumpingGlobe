/** Small least-recently-used cache keyed by strings. */

export class LruCache<CachedValue> {
  private readonly entryMap = new Map<string, CachedValue>();

  /**
   * Create a cache.
   *
   * Usage: ``new LruCache<LandLoadResult>(8)``.
   *
   * @param maxEntries - Capacity; the least recently used entry is evicted beyond it.
   */
  constructor(private readonly maxEntries: number) {}

  /**
   * Read an entry and mark it most recently used.
   *
   * Usage: cache lookups.
   *
   * @param cacheKey - Entry key.
   * @returns The value, or undefined when absent.
   */
  getEntry(cacheKey: string): CachedValue | undefined {
    const cachedValue = this.entryMap.get(cacheKey);
    if (cachedValue === undefined) return undefined;
    this.entryMap.delete(cacheKey);
    this.entryMap.set(cacheKey, cachedValue);
    return cachedValue;
  }

  /**
   * Insert or replace an entry, evicting the oldest ones over capacity.
   *
   * Usage: store a finished result.
   *
   * @param cacheKey - Entry key.
   * @param cachedValue - Value to store.
   * @returns Nothing.
   */
  setEntry(cacheKey: string, cachedValue: CachedValue): void {
    if (this.entryMap.has(cacheKey)) this.entryMap.delete(cacheKey);
    this.entryMap.set(cacheKey, cachedValue);
    while (this.entryMap.size > this.maxEntries) {
      const oldestKey = this.entryMap.keys().next().value as string;
      this.entryMap.delete(oldestKey);
    }
  }

  /**
   * Remove every entry.
   *
   * Usage: evict detail when the view or age changes.
   *
   * @returns Nothing.
   */
  clearAll(): void {
    this.entryMap.clear();
  }
}
