import { describe, expect, it } from 'vitest';
import type { PlayerMove } from './types';
import { applyMove, getLegalActions } from './betting';
import { Table, expectError, legalFor } from './test-utils';

/**
 * Mutation-hardening tests for betting.ts under the ante engine. Each test
 * pins a rule a surviving Stryker mutant would break. applyMove is also probed
 * directly (on a structuredClone of the table state) so its error/applied
 * result objects are asserted exactly.
 *
 * Geometry with zeroRand: the first hand's button lands on the lowest eligible
 * seat (p0), so inHand starts left of the button — heads-up that is [p1, p0]
 * and p1 acts first on every street. Default config: ante 1, minBet 2,
 * startingStack 20 (19 behind after the ante).
 */

type MoveResult = ReturnType<typeof applyMove>;

function errOf(res: MoveResult) {
  if (!('error' in res) || !res.error) throw new Error('expected an error result');
  return res.error;
}

function appliedOf(res: MoveResult) {
  if (!('applied' in res) || !res.applied) throw new Error('expected an applied result');
  return res.applied;
}

/** applyMove on a clone so probes never disturb the table under test. */
function probe(t: Table, playerId: string, move: PlayerMove, amount?: number): MoveResult {
  return applyMove(structuredClone(t.state), playerId, move, amount);
}

/** Heads-up table, hand started; p0 = button, p1 first to act every street. */
function headsUp(stacks?: number[]): Table {
  const t = new Table(2, stacks ? { stacks } : {});
  t.start();
  return t;
}

/** Heads-up table advanced to the flop (checked-through preflop). */
function headsUpFlop(stacks?: number[]): Table {
  const t = headsUp(stacks);
  t.act('p1', 'check');
  t.act('p0', 'check');
  return t;
}

describe('getLegalActions guards', () => {
  it('returns null when no hand is live and for a player not on the clock', () => {
    const t = new Table(2); // still in lobby, no hand
    expect(getLegalActions(t.state, 'p0')).toBeNull();
    t.start();
    expect(t.toAct).toBe('p1'); // non-button acts first
    expect(getLegalActions(t.state, 'p0')).toBeNull();
  });

  it('applyMove for a player not on the clock is rejected', () => {
    const t = headsUp();
    const e = errOf(probe(t, 'p0', 'call'));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('ante-era preflop opens check-or-bet', () => {
  it('antes are posted to the whole-hand pot, not the street', () => {
    const t = headsUp();
    expect(t.hand.totalCommitted).toEqual({ p0: 1, p1: 1 });
    expect(t.stack('p0')).toBe(19);
    expect(t.stack('p1')).toBe(19);
    expect(t.hand.round.committed).toEqual({});
    expect(t.hand.round.currentBet).toBe(0);
    expect(t.state.events.some((e) => e.type === 'antes-posted')).toBe(true);
  });

  it('first to act preflop may check or open-bet at the min bet; no call/raise exists', () => {
    const t = headsUp();
    const legal = legalFor(t.state, 'p1');
    expect(legal.canFold).toBe(true);
    expect(legal.canCheck).toBe(true);
    expect(legal.canBet).toBe(true);
    expect(legal.callAmount).toBe(0);
    expect(legal.canRaise).toBe(false);
    expect(legal.minRaiseTo).toBe(2); // config.minBet
    expect(legal.maxRaiseTo).toBe(19); // stack after the ante
  });
});

describe('applyMove results', () => {
  it('applied moves report the normalized move and amount', () => {
    const t = headsUp();
    expect(appliedOf(probe(t, 'p1', 'fold'))).toEqual({ move: 'fold', amount: 0 });
    expect(appliedOf(probe(t, 'p1', 'check'))).toEqual({ move: 'check', amount: 0 });
    expect(appliedOf(probe(t, 'p1', 'bet', 4))).toEqual({ move: 'bet', amount: 4 });
    // A "raise" with no bet outstanding is normalized to a bet…
    expect(appliedOf(probe(t, 'p1', 'raise', 4))).toEqual({ move: 'bet', amount: 4 });
    t.act('p1', 'bet', 2);
    expect(appliedOf(probe(t, 'p0', 'call'))).toEqual({ move: 'call', amount: 2 });
    expect(appliedOf(probe(t, 'p0', 'raise', 6))).toEqual({ move: 'raise', amount: 6 });
    // …and a "bet" into an outstanding bet is normalized to a raise.
    expect(appliedOf(probe(t, 'p0', 'bet', 6))).toEqual({ move: 'raise', amount: 6 });
  });

  it('checking while facing a bet is rejected with illegal-move', () => {
    const t = headsUp();
    t.act('p1', 'bet', 2);
    const e = errOf(probe(t, 'p0', 'check'));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });

  it('calling with nothing to call is rejected with illegal-move', () => {
    const t = headsUp();
    const e = errOf(probe(t, 'p1', 'call'));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });

  it('rejects bad bet/raise amounts with bad-amount and a real message', () => {
    const t = headsUp();
    // Below-minimum opening bet while not all-in.
    let e = errOf(probe(t, 'p1', 'bet', 1));
    expect(e.code).toBe('bad-amount');
    expect(e.message).toMatch(/minimum is 2/i);

    t.act('p1', 'bet', 5); // full bet: min-raise basis becomes 5
    // Fractional amount.
    e = errOf(probe(t, 'p0', 'raise', 7.5));
    expect(e.code).toBe('bad-amount');
    expect(e.message.length).toBeGreaterThan(0);
    // Raise to exactly the current bet.
    e = errOf(probe(t, 'p0', 'raise', 5));
    expect(e.code).toBe('bad-amount');
    expect(e.message).toMatch(/exceed/i);
    // Below the minimum raise while not all-in.
    e = errOf(probe(t, 'p0', 'raise', 8));
    expect(e.code).toBe('bad-amount');
    expect(e.message).toMatch(/minimum is 10/i);
    // Beyond the stack (max raise-to is 19).
    e = errOf(probe(t, 'p0', 'raise', 25));
    expect(e.code).toBe('bad-amount');
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('fresh-street legal actions', () => {
  it('with no bet outstanding: check/bet available, raise and call are not', () => {
    const t = headsUpFlop();
    const legal = legalFor(t.state, 'p1');
    expect(legal.canCheck).toBe(true);
    expect(legal.canBet).toBe(true);
    expect(legal.callAmount).toBe(0);
    expect(legal.canRaise).toBe(false);
    // The fresh street re-seeds the min-raise basis at minBet.
    expect(t.hand.round.lastFullRaiseSize).toBe(2);
    expect(t.hand.round.lastFullRaiseTo).toBe(0);
  });

  it('a player with no chips behind cannot open-bet', () => {
    const t = headsUpFlop();
    const s = structuredClone(t.state);
    s.players.p1.stack = 0;
    const legal = getLegalActions(s, 'p1')!;
    expect(legal.kind).toBe('betting');
    if (legal.kind !== 'betting') throw new Error('unreachable');
    expect(legal.canBet).toBe(false);
    const e = errOf(applyMove(s, 'p1', 'bet', 2));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('min-raise math', () => {
  it('a full bet sets the basis; a full raise resets it to the raise increment', () => {
    const t = headsUpFlop();
    t.act('p1', 'bet', 4); // full bet: size 4
    let legal = legalFor(t.state, 'p0');
    expect(legal.callAmount).toBe(4);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(8); // 4 + 4

    t.act('p0', 'raise', 10); // full raise: increment 6 becomes the new basis
    expect(t.hand.round.lastFullRaiseSize).toBe(6);
    expect(t.hand.round.lastFullRaiseTo).toBe(10);
    expect(t.hand.round.actedSinceFullRaise).toEqual(['p0']);
    legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(true); // full raise reopens the original bettor
    expect(legal.minRaiseTo).toBe(16); // 10 + 6
  });
});

describe('raise-to semantics', () => {
  // Matching the bet exactly all-in is a call, never a raise.
  it('no raise available when calling would already be exactly all-in', () => {
    const t = headsUpFlop([12, 100]); // p0 has exactly 11 behind on the flop
    t.act('p1', 'bet', 11);
    const legal = legalFor(t.state, 'p0');
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(11);
    expect(legal.maxRaiseTo).toBe(11);
  });

  // A raise "to" the current bet must fail as not exceeding it (mutants
  // reroute this to the minimum-raise message).
  it('a raise to exactly the current bet is rejected as not exceeding it', () => {
    const t = headsUpFlop([17, 100]); // p0 has 16 behind: canRaise is true
    t.act('p1', 'bet', 10);
    expect(legalFor(t.state, 'p0').canRaise).toBe(true);
    const res = t.tryAct('p0', 'raise', 10);
    expectError(res, 'bad-amount');
    if (!res.ok) expect(res.error.message).toMatch(/exceed/i);
  });

  // An all-in bet below the min bet is not a full bet — it neither reopens
  // betting to a player who already checked nor becomes the new min-raise
  // basis (that stays the min bet).
  it('an under-minBet all-in bet is short: no reopen, min-raise basis stays minBet', () => {
    const t = headsUpFlop([2, 100]); // p0 has exactly 1 chip on the flop
    t.act('p1', 'check');
    t.act('p0', 'bet', 1); // all-in below the min bet
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(false); // p1 already checked; short bet reopens nothing
    expect(legal.minRaiseTo).toBe(3); // 1 (bet) + 2 (minBet basis), not 1 + 1
  });
});

describe('short all-in raises', () => {
  // One river scenario kills several mutants at once: the short all-in raise
  // is accepted, does not reopen betting, closes with an exact
  // actedSinceFullRaise list, and the betting-closed error has a message.
  it('a short all-in raise does not reopen betting to the original bettor', () => {
    const t = new Table(2, { stacks: [15, 100] }); // p0 has 14 behind after the ante
    t.start();
    t.act('p1', 'check');
    t.act('p0', 'check'); // flop
    t.act('p1', 'check');
    t.act('p0', 'check'); // turn
    t.act('p1', 'check');
    t.act('p0', 'check'); // river
    expect(t.hand.round.street).toBe('river');
    t.act('p1', 'bet', 10);
    t.act('p0', 'raise', 14); // all-in, 4 over — short of the 10 min-raise

    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(4);

    const res = t.tryAct('p1', 'raise', 30);
    expectError(res, 'illegal-move');
    if (!res.ok) expect(res.error.message.length).toBeGreaterThan(0);

    t.act('p1', 'call'); // showdown
    expect(t.state.hand!.result).not.toBeNull();
    // Exact list: no duplicate for p1, and the short raiser p0 is recorded.
    expect(t.state.hand!.round.actedSinceFullRaise).toEqual(['p1', 'p0']);
  });

  it('cumulative short all-ins amounting to a full raise reopen betting (TDA)', () => {
    // Button p0; deal order [p1, p2, p0]. After the ante: p1 has 16, p2 has 20.
    const t = new Table(3, { stacks: [200, 17, 21] });
    t.start();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check'); // flop
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'bet', 10); // full bet: size 10, level 10
    t.act('p1', 'raise', 16); // short all-in (+6)
    t.act('p2', 'raise', 20); // short all-in — cumulatively +10 = a full raise

    expect(t.hand.round.actedSinceFullRaise).toEqual(['p2']);
    expect(t.hand.round.lastFullRaiseTo).toBe(20);
    expect(t.hand.round.lastFullRaiseSize).toBe(10); // min-raise basis unchanged

    const legal = legalFor(t.state, 'p0');
    expect(legal.canRaise).toBe(true); // betting reopened to the original bettor
    expect(legal.minRaiseTo).toBe(30); // 20 + last FULL raise size 10
  });
});

describe('turn order', () => {
  it('first to act is left of the button on every street (3-handed)', () => {
    const t = new Table(3);
    t.start();
    expect(t.hand.buttonSeat).toBe(0);
    expect(t.hand.inHand).toEqual(['p1', 'p2', 'p0']);
    expect(t.toAct).toBe('p1'); // preflop
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.toAct).toBe('p1'); // flop restarts left of the button
  });
});

describe('ante all-ins', () => {
  it('a player anted all-in takes no turns; a lone remaining actor checks it down to showdown', () => {
    const t = new Table(2, { stacks: [1, 20] });
    t.start();
    expect(t.hand.allIn).toEqual(['p0']); // the ante took p0's whole stack
    expect(t.hand.totalCommitted).toEqual({ p0: 1, p1: 1 });
    expect(t.toAct).toBe('p1'); // the only remaining actor
    t.act('p1', 'check');
    // No one can bet anywhere — the board runs out and the hand resolves.
    expect(t.state.hand!.result).not.toBeNull();
    expect(t.hand.board).toHaveLength(5);
    expect(t.state.phase).toBe('hand-over');
    expect(t.totalChips()).toBe(21); // conservation across the auto-runout
  });

  it('everyone anted all-in: the hand auto-runs to showdown with zero turns', () => {
    const t = new Table(2, { stacks: [1, 1] });
    t.start();
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.hand!.result).not.toBeNull();
    expect(t.hand.board).toHaveLength(5);
    expect(t.totalChips()).toBe(2);
    // Whole pot paid out: winner(s) hold everything.
    const paid = t.state.hand!.result!.pots.reduce((a, p) => a + p.amount, 0);
    expect(paid).toBe(2);
  });
});
