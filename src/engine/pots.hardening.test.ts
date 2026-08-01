import { describe, expect, it } from 'vitest';
import { buildPots } from './pots';
import type { HandState } from './types';

/**
 * Mutation-hardening tests for buildPots: direct calls with hand-built
 * HandStates so ordering/arithmetic mutants flip an observable pot layout.
 */

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

describe('buildPots hardening', () => {
  it('returns exactly { refunds: {}, pots: [] } when nobody committed anything', () => {
    const built = buildPots(mkHand({ inHand: ['a', 'b'], totalCommitted: {} }));
    expect(built).toEqual({ refunds: {}, pots: [] });
  });

  it('refunds the uncalled excess to the biggest committer even when they are first in hand order', () => {
    // 'a' (first in inHand) put in 100, 'b' only had 50 — 50 must come back to 'a'.
    // A broken descending sort of committers would pick the wrong "top" player.
    const built = buildPots(
      mkHand({ inHand: ['a', 'b'], totalCommitted: { a: 100, b: 50 } })
    );
    expect(built).toEqual({
      refunds: { a: 50 },
      pots: [{ amount: 100, eligible: ['a', 'b'] }],
    });
  });

  it('emits no zero-amount refund entry when the top commitments tie', () => {
    const built = buildPots(
      mkHand({ inHand: ['a', 'b'], totalCommitted: { a: 60, b: 60 } })
    );
    // Strict deep equality: refunds must have NO keys (not { a: 0 }).
    expect(built).toEqual({
      refunds: {},
      pots: [{ amount: 120, eligible: ['a', 'b'] }],
    });
  });

  it('layers side pots ascending even when the short stack sits later in hand order', () => {
    // Contribution levels are discovered in inHand order (100 before 40); they
    // must still be layered 40-first. An unsorted/broken-comparator levels list
    // would build a single 240 pot that excludes the short stack entirely.
    const built = buildPots(
      mkHand({ inHand: ['a', 'b', 'c'], totalCommitted: { a: 100, b: 40, c: 100 } })
    );
    expect(built).toEqual({
      refunds: {},
      pots: [
        { amount: 120, eligible: ['a', 'b', 'c'] },
        { amount: 120, eligible: ['a', 'c'] },
      ],
    });
  });

  it("folded players' chips land in the layers they reached without earning eligibility", () => {
    // c folded after committing 30: main layer gets c's 30, side layer none.
    const built = buildPots(
      mkHand({
        inHand: ['a', 'b', 'c'],
        folded: ['c'],
        totalCommitted: { a: 80, b: 80, c: 30 },
      })
    );
    expect(built).toEqual({
      refunds: {},
      pots: [{ amount: 190, eligible: ['a', 'b'] }],
    });
  });

  it('an ante-broke player forms the bottom layer: everyone contributes to it', () => {
    // Ante era: 'c' could only ante 1 while 'a'/'b' anted 1 and bet on. The
    // 3-chip bottom layer must include c; the rest layers above without them.
    const built = buildPots(
      mkHand({
        inHand: ['a', 'b', 'c'],
        allIn: ['c'],
        totalCommitted: { a: 9, b: 9, c: 1 },
      })
    );
    expect(built).toEqual({
      refunds: {},
      pots: [
        { amount: 3, eligible: ['a', 'b', 'c'] },
        { amount: 16, eligible: ['a', 'b'] },
      ],
    });
  });
});

/**
 * Dead money above every contesting player's level (play-testing leak,
 * 2026-08-01, fuzz seed 19): baseball's bust-out FOLDS a player who ran out
 * of cards even though they are all-in, so the hand can reach showdown where
 * the deepest committers are all folded. Their chips above the top contesting
 * level belong in the pot — they were bet and forfeited — not dropped.
 */
describe('folded dead money above the contesting levels', () => {
  const conserve = (hand: HandState) => {
    const { refunds, pots } = buildPots(hand);
    const inPots = pots.reduce((a, p) => a + p.amount, 0);
    const refunded = Object.values(refunds).reduce((a, b) => a + b, 0);
    const committed = Object.values(hand.totalCommitted).reduce((a, b) => a + b, 0);
    return { refunds, pots, total: inPots + refunded, committed };
  };

  it('two deep flip-busted players: their excess joins the top pot', () => {
    // Mirrors fuzz seed 19: shorts all-in at 1/1/3, deeps at 17 both folded.
    const hand = mkHand({
      inHand: ['a', 'b', 'c', 'd', 'e'],
      folded: ['d', 'e'],
      allIn: ['a', 'b', 'c', 'd', 'e'],
      totalCommitted: { a: 1, b: 1, c: 3, d: 17, e: 17 },
    });
    const { pots, total, committed } = conserve(hand);
    expect(total).toBe(committed); // 39 — nothing vanishes
    // Layers: level-1 main (5), level-3 side (6) + the 28 of dead money.
    expect(pots).toEqual([
      { amount: 5, eligible: ['a', 'b', 'c'] },
      { amount: 6 + 28, eligible: ['c'] },
    ]);
  });

  it('a single deep folded player still gets the uncalled excess back first', () => {
    // d bet 20, e called 17 all-in, then BOTH busted out: d's uncalled 3
    // comes back, the called 34 minus layer money is dead in the top pot.
    const hand = mkHand({
      inHand: ['c', 'd', 'e'],
      folded: ['d', 'e'],
      allIn: ['c', 'd', 'e'],
      totalCommitted: { c: 3, d: 20, e: 17 },
    });
    const { refunds, total, committed } = conserve(hand);
    expect(refunds).toEqual({ d: 3 });
    expect(total).toBe(committed); // 40 — refund 3 + pots 37
  });

  // Equivalent-mutant note: `dead > 0` → `dead >= 0` (and `→ true`) cannot be
  // killed — dead is a sum of Math.max(0, ·) terms so it is never negative,
  // dead === 0 makes the last-pot arm a `+= 0` no-op, and the push arm needs
  // pots to be empty, which forces dead > 0 (every id has a positive total).
  it('degenerate: everyone who committed also folded — chips still potted', () => {
    // Unreachable through the engine (a fold-win fires at one active player)
    // but buildPots' contract is unconditional conservation.
    const hand = mkHand({
      inHand: ['a', 'b'],
      folded: ['a', 'b'],
      totalCommitted: { a: 5, b: 3 },
    });
    const { refunds, pots } = buildPots(hand);
    expect(refunds).toEqual({ a: 2 }); // uncalled excess still comes back
    expect(pots).toEqual([{ amount: 6, eligible: [] }]);
  });
});
