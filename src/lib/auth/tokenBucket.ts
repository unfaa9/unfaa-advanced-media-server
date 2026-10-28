// In-memory token buckets keyed by API key id or client IP. Single process (PM2 fork mode).
export class TokenBuckets {
  private buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    private ratePerSec: number,
    private burst: number,
    private maxEntries = 10_000
  ) {}

  // Takes one token. Returns 0 when allowed, otherwise the seconds to wait.
  take(id: string, now = Date.now()): number {
    let b = this.buckets.get(id);
    if (!b) {
      if (this.buckets.size >= this.maxEntries) this.evictFull(now);
      b = { tokens: this.burst, at: now };
      this.buckets.set(id, b);
    }
    b.tokens = Math.min(
      this.burst,
      b.tokens + ((now - b.at) / 1000) * this.ratePerSec
    );
    b.at = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - b.tokens) / this.ratePerSec);
  }

  // Peeks without consuming (is this client currently throttled?).
  blockedFor(id: string, now = Date.now()): number {
    const b = this.buckets.get(id);
    if (!b) return 0;
    const tokens = Math.min(
      this.burst,
      b.tokens + ((now - b.at) / 1000) * this.ratePerSec
    );
    return tokens >= 1 ? 0 : Math.ceil((1 - tokens) / this.ratePerSec);
  }

  // Drops buckets that have refilled completely; they carry no state.
  private evictFull(now: number) {
    for (const [id, b] of this.buckets) {
      if (b.tokens + ((now - b.at) / 1000) * this.ratePerSec >= this.burst) {
        this.buckets.delete(id);
      }
    }
  }
}
