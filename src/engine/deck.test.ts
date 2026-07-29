import { describe, expect, it } from 'vitest';
import { newDeck, shuffle, rankValue } from './deck';
import { seededRandInt } from './test-utils';

describe('newDeck', () => {
  it('has exactly 52 unique cards', () => {
    const deck = newDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
  });

  it('has 13 cards of each suit and 4 of each rank', () => {
    const deck = newDeck();
    for (const suit of ['s', 'h', 'd', 'c']) {
      expect(deck.filter((c) => c[1] === suit)).toHaveLength(13);
    }
    for (let v = 2; v <= 14; v++) {
      expect(deck.filter((c) => rankValue(c) === v)).toHaveLength(4);
    }
  });
});

describe('shuffle', () => {
  it('preserves the multiset of cards and does not mutate input', () => {
    const deck = newDeck();
    const copy = deck.slice();
    const shuffled = shuffle(deck, seededRandInt(42));
    expect(deck).toEqual(copy);
    expect(shuffled).toHaveLength(52);
    expect([...shuffled].sort()).toEqual([...deck].sort());
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const deck = newDeck();
    expect(shuffle(deck, seededRandInt(1))).toEqual(shuffle(deck, seededRandInt(1)));
    expect(shuffle(deck, seededRandInt(1))).not.toEqual(shuffle(deck, seededRandInt(2)));
  });

  it('produces a roughly uniform position distribution (chi-squared smoke test)', () => {
    // Track where card 0 of a 4-card array lands over many shuffles.
    const counts = [0, 0, 0, 0];
    const rand = seededRandInt(7);
    for (let n = 0; n < 8000; n++) {
      const out = shuffle([0, 1, 2, 3], rand);
      counts[out.indexOf(0)]++;
    }
    // Expected 2000 each; allow generous tolerance.
    for (const c of counts) {
      expect(c).toBeGreaterThan(1800);
      expect(c).toBeLessThan(2200);
    }
  });
});
