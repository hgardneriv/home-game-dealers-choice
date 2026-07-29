import { describe, expect, it } from 'vitest';
import { resolveFoldWin, resolveShowdown } from './showdown';
import type { HandState } from './types';

/**
 * Mutation-hardening tests for resolveShowdown/resolveFoldWin: direct calls
 * with hand-built HandStates targeting reveal-order, auto-muck, and odd-chip
 * survivors.
 */

const mkHand = (over: Partial<HandState>): HandState => ({
  handNo: 1,
  deck: [],
  deckPos: 0,
  buttonSeat: 0,
  sbSeat: 1,
  deadSb: false,
  bbSeat: 2,
  holeCards: {},
  board: [],
  inHand: [],
  folded: [],
  allIn: [],
  totalCommitted: {},
  round: {
    street: 'river',
    currentBet: 0,
    lastFullRaiseSize: 2,
    lastFullRaiseTo: 0,
    committed: {},
    actedSinceFullRaise: [],
    lastAggressor: null,
    toAct: null,
    actionDeadline: null,
    timeBankArmed: false,
    botActAt: null,
  },
  result: null,
  ...over,
});

describe('resolveShowdown hardening', () => {
  it('reveal order starts at the last aggressor, then clockwise', () => {
    const hand = mkHand({
      inHand: ['a', 'b', 'c'],
      board: ['Kh', 'Qd', '3c', '9h', '5d'],
      holeCards: { a: ['2c', '2d'], b: ['As', 'Ad'], c: ['7s', '8s'] },
      totalCommitted: { a: 10, b: 10, c: 10 },
    });
    hand.round.lastAggressor = 'b';
    const { result, payouts } = resolveShowdown(hand);
    expect(result.showdownOrder).toEqual(['b', 'c', 'a']);
    // b's aces win everything; the beaten hands auto-muck.
    expect(Object.keys(result.revealed)).toEqual(['b']);
    expect(payouts).toEqual({ b: 30 });
  });

  it('a folded last aggressor is ignored: order starts left of the button, ties both reveal, odd chip goes first-clockwise', () => {
    // Broadway on board — a and b tie playing the board; c folded 5 in as the
    // (stale) last aggressor. Pot is 25 → 13/12 split, odd chip to 'a'.
    const hand = mkHand({
      inHand: ['a', 'b', 'c'],
      folded: ['c'],
      board: ['Ah', 'Kd', 'Qs', 'Jc', 'Th'],
      holeCards: { a: ['2c', '3d'], b: ['4h', '5s'], c: ['9c', '9d'] },
      totalCommitted: { a: 10, b: 10, c: 5 },
    });
    hand.round.lastAggressor = 'c';
    const { result, payouts } = resolveShowdown(hand);
    expect(result.showdownOrder).toEqual(['a', 'b']);
    // Tie: b matches the best shown hand, so b must reveal too (no auto-muck).
    expect(Object.keys(result.revealed).sort()).toEqual(['a', 'b']);
    expect(result.descriptions).toEqual({
      a: 'Straight, Ace High',
      b: 'Straight, Ace High',
    });
    expect(result.pots).toEqual([
      { amount: 25, winners: ['a', 'b'], eligible: ['a', 'b'] },
    ]);
    expect(payouts).toEqual({ a: 13, b: 12 });
  });

  it('an uncontested showdown reveals nothing', () => {
    // Defensive path: only one non-folded player but resolveShowdown is called.
    const hand = mkHand({
      inHand: ['a', 'b'],
      folded: ['b'],
      board: ['Ah', 'Kd', 'Qs', 'Jc', 'Th'],
      holeCards: { a: ['2c', '3d'], b: ['9c', '9d'] },
      totalCommitted: { a: 10, b: 10 },
    });
    const { result, payouts } = resolveShowdown(hand);
    expect(result.revealed).toEqual({});
    expect(payouts).toEqual({ a: 20 });
  });

  it("a main-pot-only monster does not muck the side pot winner's reveal", () => {
    // s is all-in short with quad aces (main pot only). b wins the side pot
    // with a full house and MUST still be revealed; c's two pair mucks.
    const hand = mkHand({
      inHand: ['s', 'b', 'c'],
      board: ['Ac', 'Ah', 'Kd', '7s', '2h'],
      holeCards: { s: ['As', 'Ad'], b: ['Kh', 'Ks'], c: ['Qs', 'Qd'] },
      totalCommitted: { s: 20, b: 50, c: 50 },
    });
    const { result, payouts } = resolveShowdown(hand);
    expect(result.pots).toEqual([
      { amount: 60, winners: ['s'], eligible: ['s', 'b', 'c'] },
      { amount: 60, winners: ['b'], eligible: ['b', 'c'] },
    ]);
    expect(Object.keys(result.revealed).sort()).toEqual(['b', 's']);
    expect(payouts).toEqual({ s: 60, b: 60 });
  });
});

describe('resolveFoldWin hardening', () => {
  it('builds a single-winner pot with exact winners/eligible and an empty showdown order', () => {
    const hand = mkHand({
      inHand: ['a', 'b'],
      folded: ['b'],
      totalCommitted: { a: 5, b: 2 },
    });
    const { result, payouts } = resolveFoldWin(hand);
    expect(result).toEqual({
      pots: [{ amount: 7, winners: ['a'], eligible: ['a'] }],
      revealed: {},
      descriptions: {},
      showdownOrder: [],
      refunds: {},
    });
    expect(payouts).toEqual({ a: 7 });
  });
});
