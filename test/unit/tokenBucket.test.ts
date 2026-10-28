import { describe, expect, it } from 'vitest';
import { TokenBuckets } from '../../src/lib/auth/tokenBucket';

describe('TokenBuckets', () => {
  it('allows a burst, then asks to wait, then refills', () => {
    const b = new TokenBuckets(1, 3);
    const t = 1_000_000;
    expect([b.take('k', t), b.take('k', t), b.take('k', t)]).toEqual([0, 0, 0]);
    expect(b.take('k', t)).toBe(1);
    expect(b.take('k', t + 1000)).toBe(0);
  });
});
