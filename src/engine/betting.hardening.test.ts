import { describe, expect, it } from 'vitest';
import type { HandState, PlayerMove } from './types';
import { applyMove, getLegalActions, isRoundComplete } from './betting';
import { Table, expectError, legalFor } from './test-utils';

/**
 * Mutation-hardening tests for betting.ts. Each test pins a rule a surviving
 * Stryker mutant would break. applyMove is also probed directly (on a
 * structuredClone of the table state) so its error/applied result objects are
 * asserted exactly — the engine-level tests never inspected them, which is why
 * most of the error returns showed up as no-coverage mutants.
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

/** Heads-up table, hand started; p0 = button/SB is first to act preflop. */
function headsUpPreflop(stacks?: number[]): Table {
  const t = new Table(2, stacks ? { stacks } : {});
  t.start();
  return t;
}

/** Heads-up table advanced to the flop (limped pot); p1 = BB acts first. */
function headsUpFlop(stacks?: number[]): Table {
  const t = headsUpPreflop(stacks);
  t.act('p0', 'call');
  t.act('p1', 'check');
  return t;
}

describe('isRoundComplete', () => {
  // Kills the uncovered L53 BlockStatement {} and L54 conditional/equality mutants.
  it('is true exactly when nobody is left to act', () => {
    const frag = (toAct: string | null) => ({ round: { toAct } }) as unknown as HandState;
    expect(isRoundComplete(frag(null))).toBe(true);
    expect(isRoundComplete(frag('p0'))).toBe(false);
  });
});

describe('getLegalActions guards', () => {
  // Kills L59 LogicalOperator (&&) and ConditionalExpression false mutants:
  // the && variant dereferences hand.round on a missing hand and would throw.
  it('returns null when no hand is live and for a player not on the clock', () => {
    const t = new Table(2); // still in lobby, no hand
    expect(getLegalActions(t.state, 'p0')).toBeNull();
    t.start();
    expect(t.toAct).toBe('p0');
    expect(getLegalActions(t.state, 'p1')).toBeNull();
  });
});

describe('preflop legal actions and applyMove results', () => {
  it('facing the blind: fold always legal, no check, no open-bet, call = 1', () => {
    const t = headsUpPreflop();
    const legal = legalFor(t.state, 'p0');
    expect(legal.canFold).toBe(true); // kills L74 BooleanLiteral false
    expect(legal.canCheck).toBe(false);
    expect(legal.canBet).toBe(false); // kills L67 ConditionalExpression true
    expect(legal.callAmount).toBe(1);
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(4);
    expect(legal.maxRaiseTo).toBe(20);
  });

  // Kills L120 ConditionalExpression false and the uncovered L121 object/string mutants.
  it('checking while facing a bet is rejected with illegal-move', () => {
    const t = headsUpPreflop();
    const e = errOf(probe(t, 'p0', 'check'));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });

  // Kills L117 / L130 ObjectLiteral {} and the L171 string/object mutants.
  it('applied moves report the normalized move and amount', () => {
    const t = headsUpPreflop();
    expect(appliedOf(probe(t, 'p0', 'fold'))).toEqual({ move: 'fold', amount: 0 });
    expect(appliedOf(probe(t, 'p0', 'call'))).toEqual({ move: 'call', amount: 1 });
    expect(appliedOf(probe(t, 'p0', 'raise', 6))).toEqual({ move: 'raise', amount: 6 });
    t.act('p0', 'call');
    // kills L123 ObjectLiteral {} (legal BB check)
    expect(appliedOf(probe(t, 'p1', 'check'))).toEqual({ move: 'check', amount: 0 });
    t.act('p1', 'check'); // to the flop
    expect(t.toAct).toBe('p1');
    expect(appliedOf(probe(t, 'p1', 'bet', 4))).toEqual({ move: 'bet', amount: 4 });
  });

  it('rejects bad raise amounts with bad-amount and a real message', () => {
    const t = headsUpPreflop();
    // kills L140 ConditionalExpression false + uncovered L141 object/string mutants
    let e = errOf(probe(t, 'p0', 'raise', 5.5));
    expect(e.code).toBe('bad-amount');
    expect(e.message.length).toBeGreaterThan(0);
    // kills uncovered L145 object/string mutants (raise to exactly the current bet)
    e = errOf(probe(t, 'p0', 'raise', 2));
    expect(e.code).toBe('bad-amount');
    expect(e.message).toMatch(/exceed/i);
    // kills L149 StringLiteral `` (below-minimum raise while not all-in)
    e = errOf(probe(t, 'p0', 'raise', 3));
    expect(e.code).toBe('bad-amount');
    expect(e.message.length).toBeGreaterThan(0);
    // kills L142 ConditionalExpression false + uncovered L143 object/string mutants
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
    // kills L68 EqualityOperator (currentBet >= 0) and ConditionalExpression true
    expect(legal.canRaise).toBe(false);
    // kills L126 ConditionalExpression false / EqualityOperator < 0 and the
    // uncovered L127 object/string mutants
    const e = errOf(probe(t, 'p1', 'call'));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });

  // Kills L67 EqualityOperator (stack >= 0), L135 ConditionalExpression false,
  // and the uncovered L136 object/string mutants.
  it('a player with no chips behind cannot open-bet', () => {
    const t = headsUpFlop();
    const s = structuredClone(t.state);
    s.players.p1.stack = 0;
    const legal = getLegalActions(s, 'p1')!;
    expect(legal.canBet).toBe(false);
    const e = errOf(applyMove(s, 'p1', 'bet', 2));
    expect(e.code).toBe('illegal-move');
    expect(e.message.length).toBeGreaterThan(0);
  });
});

describe('raise-to semantics', () => {
  // Kills L68 EqualityOperator (maxTo >= currentBet): matching the bet exactly
  // all-in is a call, never a raise.
  it('no raise available when calling would already be exactly all-in', () => {
    const t = headsUpFlop([12, 100]); // p0 has exactly 10 behind on the flop
    t.act('p1', 'bet', 10);
    const legal = legalFor(t.state, 'p0');
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(10);
    expect(legal.maxRaiseTo).toBe(10);
  });

  // Kills L144 EqualityOperator (<) and ConditionalExpression false: a raise
  // "to" the current bet must fail as not exceeding it (the mutants reroute to
  // the minimum-raise message).
  it('a raise to exactly the current bet is rejected as not exceeding it', () => {
    const t = headsUpFlop([17, 100]); // p0 has 15 behind: canRaise is true
    t.act('p1', 'bet', 10);
    expect(legalFor(t.state, 'p0').canRaise).toBe(true);
    const res = t.tryAct('p0', 'raise', 10);
    expectError(res, 'bad-amount');
    if (!res.ok) expect(res.error.message).toMatch(/exceed/i);
  });

  // Kills L155 ConditionalExpression true: an all-in bet below the big blind
  // is not a full bet — it neither reopens betting to a player who already
  // checked nor becomes the new min-raise basis (that stays the big blind).
  it('an under-BB all-in bet is short: no reopen, min-raise basis stays the BB', () => {
    const t = headsUpFlop([3, 100]); // p0 has exactly 1 chip on the flop
    t.act('p1', 'check');
    t.act('p0', 'bet', 1); // all-in below the BB
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(false); // p1 already checked; short bet reopens nothing
    expect(legal.minRaiseTo).toBe(3); // 1 (bet) + 2 (BB basis), not 1 + 1
  });
});

describe('short all-in raises', () => {
  // One river scenario kills several mutants at once:
  // - L146 short all-in raise is accepted (the raise to 14 succeeds)
  // - L68 ConditionalExpression true on `reopened` (canRaise false after a short)
  // - L138 StringLiteral '' (betting-closed error has a message)
  // - L110 ConditionalExpression true (no duplicate actedSinceFullRaise entries)
  // - L168 BlockStatement {} (the short raiser IS recorded as having acted)
  it('a short all-in raise does not reopen betting to the original bettor', () => {
    const t = new Table(2, { stacks: [16, 100] });
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'check');
    t.act('p1', 'check');
    t.act('p0', 'check'); // flop
    t.act('p1', 'check');
    t.act('p0', 'check'); // turn
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

  // Kills L163 ConditionalExpression false / EqualityOperator (>), the
  // uncovered L163 BlockStatement {}, and the uncovered L167 ArrayDeclaration [].
  it('cumulative short all-ins amounting to a full raise reopen betting (TDA)', () => {
    const t = new Table(3, { stacks: [200, 18, 22] });
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check'); // flop: p1 has 16 behind, p2 has 20
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
  // Kills L36 EqualityOperator (i < order.length): the cyclic scan must be
  // able to come all the way back around to `fromId` itself — here the BB is
  // the only player able to act after the button posted the SB all-in.
  it('BB still gets the option when the button is all-in from posting the SB', () => {
    const t = new Table(2, { stacks: [1, 20] });
    t.start();
    expect(t.state.phase).toBe('playing');
    expect(t.toAct).toBe('p1');
  });
});
