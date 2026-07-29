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
