import { describe, expect, it } from 'vitest';
import { resolveFoldWin, resolveShowdown } from './showdown';
import { holdem } from './variants/holdem';
import type { Card, HandState, PlayerCards } from './types';

/**
 * Mutation-hardening tests for resolveShowdown/resolveFoldWin: direct calls
 * with hand-built HandStates targeting reveal-order, auto-muck, and odd-chip
 * survivors. Scoring is passed in explicitly (the new variant-scorer API);
 * these hands are all hold'em.
 */

const pcs = (cards: Record<string, Card[]>): Record<string, PlayerCards> =>
  Object.fromEntries(
    Object.entries(cards).map(([id, cs]) => [
      id,
      { cards: [...cs], faceUp: cs.map(() => false) },
    ])
  );

const mkHand = (over: Partial<HandState>): HandState => ({
  handNo: 1,
  variant: 'holdem',
  deck: [],
  deckPos: 0,
  buttonSeat: 0,
  playerCards: {},
  board: [],
  discards: [],
  inHand: [],
  folded: [],
  allIn: [],
  totalCommitted: {},
  pot: 0,
  round: {
    street: 'river',
    kind: 'betting',
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
  vstate: {},
  result: null,
  ...over,
});

const showdown = (hand: HandState) =>
  resolveShowdown(hand, holdem.score, holdem.describeScore);

describe('resolveShowdown hardening', () => {
  it('reveal order starts at the last aggressor, then clockwise', () => {
    const hand = mkHand({
      inHand: ['a', 'b', 'c'],
      board: ['Kh', 'Qd', '3c', '9h', '5d'],
      playerCards: pcs({ a: ['2c', '2d'], b: ['As', 'Ad'], c: ['7s', '8s'] }),
      totalCommitted: { a: 10, b: 10, c: 10 },
    });
    hand.round.lastAggressor = 'b';
    const { result, payouts } = showdown(hand);
    expect(result.showdownOrder).toEqual(['b', 'c', 'a']);
    // b's aces win everything; the beaten hands auto-muck.
    expect(Object.keys(result.revealed)).toEqual(['b']);
    expect(result.revealed.b).toEqual(['As', 'Ad']);
    expect(payouts).toEqual({ b: 30 });
  });

  it('a folded last aggressor is ignored: order starts left of the button, ties both reveal, odd chip goes first-clockwise', () => {
    // Broadway on board — a and b tie playing the board; c folded 5 in as the
    // (stale) last aggressor. Pot is 25 → 13/12 split, odd chip to 'a'.
    const hand = mkHand({
      inHand: ['a', 'b', 'c'],
      folded: ['c'],
      board: ['Ah', 'Kd', 'Qs', 'Jc', 'Th'],
      playerCards: pcs({ a: ['2c', '3d'], b: ['4h', '5s'], c: ['9c', '9d'] }),
      totalCommitted: { a: 10, b: 10, c: 5 },
    });
    hand.round.lastAggressor = 'c';
    const { result, payouts } = showdown(hand);
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
      playerCards: pcs({ a: ['2c', '3d'], b: ['9c', '9d'] }),
      totalCommitted: { a: 10, b: 10 },
    });
    const { result, payouts } = showdown(hand);
    expect(result.revealed).toEqual({});
    expect(payouts).toEqual({ a: 20 });
  });

  it("a main-pot-only monster does not muck the side pot winner's reveal", () => {
    // s is all-in short with quad aces (main pot only). b wins the side pot
    // with a full house and MUST still be revealed; c's two pair mucks.
    const hand = mkHand({
      inHand: ['s', 'b', 'c'],
      allIn: ['s'],
      board: ['Ac', 'Ah', 'Kd', '7s', '2h'],
      playerCards: pcs({ s: ['As', 'Ad'], b: ['Kh', 'Ks'], c: ['Qs', 'Qd'] }),
      totalCommitted: { s: 20, b: 50, c: 50 },
    });
    const { result, payouts } = showdown(hand);
    expect(result.pots).toEqual([
      { amount: 60, winners: ['s'], eligible: ['s', 'b', 'c'] },
      { amount: 60, winners: ['b'], eligible: ['b', 'c'] },
    ]);
    expect(Object.keys(result.revealed).sort()).toEqual(['b', 's']);
    expect(payouts).toEqual({ s: 60, b: 60 });
  });

  it('an ante-broke all-in wins only the ante layer; the rest goes to the bettors', () => {
    // Ante-era side pot: 's' could only ante 1 while a/b anted 1 and bet 8
    // more. s holds the best hand — they win just the 3-chip ante pot.
    const hand = mkHand({
      inHand: ['s', 'a', 'b'],
      allIn: ['s'],
      board: ['Ac', 'Ah', 'Kd', '7s', '2h'],
      playerCards: pcs({ s: ['As', 'Ad'], a: ['Kh', 'Ks'], b: ['Qs', 'Qd'] }),
      totalCommitted: { s: 1, a: 9, b: 9 },
    });
    const { result, payouts } = showdown(hand);
    expect(result.pots).toEqual([
      { amount: 3, winners: ['s'], eligible: ['s', 'a', 'b'] },
      { amount: 16, winners: ['a'], eligible: ['a', 'b'] },
    ]);
    expect(payouts).toEqual({ s: 3, a: 16 });
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
