import { describe, expect, it } from 'vitest';
import { shuffle } from './deck';

/**
 * Mutation-hardening: Fisher-Yates must draw exactly n-1 random ints
 * (maxExclusive n down to 2). An extra i === 0 iteration would consume an
 * additional randInt(1) — a wasted draw that shifts every subsequent use of
 * the injected RNG stream.
 */

describe('shuffle hardening', () => {
  it('draws exactly n-1 random ints, with maxExclusive n down to 2', () => {
    const calls: number[] = [];
    const rand = (maxExclusive: number) => {
      calls.push(maxExclusive);
      return 0;
    };
    const out = shuffle(['a', 'b', 'c', 'd'], rand);
    expect(calls).toEqual([4, 3, 2]);
    expect([...out].sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
