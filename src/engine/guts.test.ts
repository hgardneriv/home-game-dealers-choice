import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError, zeroRand } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import { guts, gutsStrength } from './variants/guts';
import { CATEGORY3, describe3, evaluate3 } from './evaluator3';
import { getLegalActions } from './betting';
import type { BotView } from './bot';
import type { BotPersonality, VariantMoveInput } from './types';

/**
 * Three-card guts scenarios. zeroRand geometry: first-hand button = seat 0
 * (p0), hand order [p1, ..., p0], p1 declares first (left of the dealer).
 */

let cleanup: () => void;
beforeEach(() => {
  cleanup = _registerVariantForTest(guts);
});
afterEach(() => {
  cleanup();
});

const GUTS = { enabledVariants: ['guts'] as ['guts'] };

function gutsTable(players = 3, config: Record<string, unknown> = {}, stacks?: number[]) {
  const t = new Table(players, { config: { ...GUTS, ...config }, stacks });
  t.start();
  return t;
}

function declare(t: Table, playerId: string, choice: 'in' | 'out') {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'declare', choice } });
}

/** Check every seat through the pre-declare betting street. */
function checkAround(t: Table) {
  let guard = 0;
  while (t.state.phase === 'playing' && t.hand.round.kind === 'betting') {
    if (guard++ > 12) throw new Error('betting street did not close');
    t.act(t.toAct!, 'check');
  }
}

/** Check through the betting street, then everyone declares `choice` in turn. */
function declareAll(t: Table, choice: 'in' | 'out' = 'in') {
  checkAround(t);
  for (const id of [...t.hand.inHand]) {
    if (t.state.phase !== 'playing') break;
    declare(t, id, choice);
  }
}

// ---------------------------------------------------------------------------
// evaluator3
// ---------------------------------------------------------------------------

describe('evaluator3', () => {
  it('ranks the categories: high < pair < flush < straight < trips < straight flush', () => {
    const ladder = [
      evaluate3(['As', 'Kd', 'Jh']), // high card
      evaluate3(['2s', '2d', '3h']), // lowest pair
      evaluate3(['2s', '5s', '9s']), // low flush
      evaluate3(['As', '2d', '3h']), // lowest straight (the wheel)
      evaluate3(['2s', '2d', '2h']), // lowest trips
      evaluate3(['As', '2s', '3s']), // lowest straight flush (wheel, suited)
    ];
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
    const categories = ladder.map((s) => s >> 20);
    expect(categories).toEqual([
      CATEGORY3.highCard,
      CATEGORY3.pair,
      CATEGORY3.flush,
      CATEGORY3.straight,
      CATEGORY3.trips,
      CATEGORY3.straightFlush,
    ]);
  });

  it('even the best of a category loses to the worst of the next', () => {
    // Best pair (aces, king kicker) < worst flush.
    expect(evaluate3(['As', 'Ad', 'Kh'])).toBeLessThan(evaluate3(['2s', '4s', '5s']));
    // Best flush (A-K-J suited, not a straight) < worst straight.
    expect(evaluate3(['As', 'Ks', 'Js'])).toBeLessThan(evaluate3(['As', '2d', '3h']));
    // Best straight (Q-K-A) < worst trips.
    expect(evaluate3(['Qs', 'Kd', 'Ah'])).toBeLessThan(evaluate3(['2s', '2d', '2h']));
    // Best trips (aces) < worst straight flush (the suited wheel).
    expect(evaluate3(['As', 'Ad', 'Ah'])).toBeLessThan(evaluate3(['As', '2s', '3s']));
  });

  it('compares high-card hands by descending ranks', () => {
    expect(evaluate3(['As', 'Kd', 'Jh'])).toBeGreaterThan(evaluate3(['As', 'Kd', 'Th']));
    // Second card outranks the third: A-K-2 beats A-Q-J.
    expect(evaluate3(['As', 'Kd', '2h'])).toBeGreaterThan(evaluate3(['As', 'Qd', 'Jh']));
    // Exact ties across suits.
    expect(evaluate3(['As', 'Kd', 'Jh'])).toBe(evaluate3(['Ah', 'Kc', 'Jd']));
  });

  it('compares pairs by pair rank then kicker', () => {
    // Pair rank dominates the kicker.
    expect(evaluate3(['3s', '3d', '2h'])).toBeGreaterThan(evaluate3(['2s', '2d', 'Ah']));
    // Same pair: kicker decides.
    expect(evaluate3(['5s', '5d', 'Kh'])).toBeGreaterThan(evaluate3(['5c', '5h', 'Qd']));
  });

  it('compares flushes by descending ranks and straights/trips by top rank', () => {
    expect(evaluate3(['As', 'Ks', '2s'])).toBeGreaterThan(evaluate3(['As', 'Qs', 'Js']));
    expect(evaluate3(['9s', 'Td', 'Jh'])).toBeGreaterThan(evaluate3(['8s', '9d', 'Th']));
    expect(evaluate3(['9s', '9d', '9h'])).toBeGreaterThan(evaluate3(['8s', '8d', '8h']));
  });

  it('A-2-3 is the LOW straight (three high); Q-K-A is the top', () => {
    const wheel = evaluate3(['As', '2d', '3h']);
    expect(wheel).toBeLessThan(evaluate3(['2s', '3d', '4h']));
    expect(describe3(wheel)).toBe('Straight, Three High');
    const top = evaluate3(['Qs', 'Kd', 'Ah']);
    expect(top).toBeGreaterThan(evaluate3(['Js', 'Qd', 'Kh']));
    expect(describe3(top)).toBe('Straight, Ace High');
    // 2-K-A is NOT a straight.
    expect(evaluate3(['2s', 'Kd', 'Ah']) >> 20).toBe(CATEGORY3.highCard);
  });

  it('describe3 names every category', () => {
    expect(describe3(evaluate3(['As', 'Kd', 'Jh']))).toBe('High Card Ace');
    expect(describe3(evaluate3(['9s', '9d', '4h']))).toBe('Pair of Nines');
    expect(describe3(evaluate3(['2s', '5s', 'Ks']))).toBe('Flush, King High');
    expect(describe3(evaluate3(['4s', '5d', '6h']))).toBe('Straight, Six High');
    expect(describe3(evaluate3(['Qs', 'Qd', 'Qh']))).toBe('Three of a Kind, Queens');
    expect(describe3(evaluate3(['As', '2s', '3s']))).toBe('Straight Flush, Three High');
    expect(describe3(evaluate3(['Qs', 'Ks', 'As']))).toBe('Straight Flush, Ace High');
  });

  it('rejects anything but exactly 3 cards', () => {
    expect(() => evaluate3(['As', 'Kd'])).toThrow();
    expect(() => evaluate3(['As', 'Kd', 'Jh', '2c'])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Hand flow: deal + declare round
// ---------------------------------------------------------------------------

describe('hand flow', () => {
  it('deals three down cards and opens the betting street ahead of the declares', () => {
    const t = gutsTable();
    expect(t.hand.variant).toBe('guts');
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet' });
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(3);
      expect(t.hand.playerCards[id].faceUp).toEqual([false, false, false]);
    }
    expect(t.hand.board).toEqual([]);
    expect(t.hand.deckPos).toBe(9);
    expect(t.toAct).toBe('p1'); // left of the dealer acts first on every street
    checkAround(t);
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'declare' });
    expect(t.toAct).toBe('p1'); // ...and declares first too
    expect(t.totalChips()).toBe(60);
  });

  it('offers exactly the declare move, with timeout defaulting to out', () => {
    const t = gutsTable();
    checkAround(t);
    expect(getLegalActions(t.state, 'p1')).toEqual({
      kind: 'exchange',
      moves: [{ kind: 'declare' }],
      autoMove: { kind: 'declare', choice: 'out' },
    });
  });

  it('declares are public as they happen and run in turn order', () => {
    const t = gutsTable(4); // order [p1, p2, p3, p0]
    checkAround(t);
    declare(t, 'p1', 'in');
    let ev = t.state.events.filter((e) => e.type === 'declared').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p1', choice: 'in' });
    expect(t.hand.folded).toEqual([]);
    expect(t.toAct).toBe('p2');

    declare(t, 'p2', 'out');
    ev = t.state.events.filter((e) => e.type === 'declared').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p2', choice: 'out' });
    expect(t.hand.folded).toEqual(['p2']); // out = folded
    expect(t.toAct).toBe('p3');
    expect(t.hand.vstate.declared).toEqual({ p1: 'in', p2: 'out' });
    expect(t.totalChips()).toBe(80);
  });

  it('two or more IN players go to showdown; the best 3-card hand takes the pot', () => {
    const t = gutsTable();
    t.rig({
      p1: ['5s', '5d', 'Kh'], // pair of fives
      p2: ['9s', '9d', '9h'], // trips — winner
      p0: ['2s', '7d', 'Jh'], // junk
    });
    declareAll(t, 'in');
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots).toEqual([{ amount: 3, winners: ['p2'], eligible: ['p1', 'p2', 'p0'] }]);
    expect(result.descriptions['p2']).toBe('Three of a Kind, Nines');
    expect(result.revealed['p2']).toEqual(['9s', '9d', '9h']);
    expect(t.stack('p2')).toBe(22); // 20 - 1 ante + 3 pot
    expect(t.totalChips()).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Fold-win: everyone dropped
// ---------------------------------------------------------------------------

describe('everyone drops', () => {
  it('the last undeclared player takes the pot WITHOUT declaring', () => {
    const t = gutsTable();
    checkAround(t);
    declare(t, 'p1', 'out');
    expect(t.totalChips()).toBe(60);
    declare(t, 'p2', 'out');
    // active() hit 1 — the engine's fold-win fired for p0 immediately.
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots).toEqual([{ amount: 3, winners: ['p0'], eligible: ['p0'] }]);
    expect(t.stack('p0')).toBe(22);
    // p0 never declared and nobody matches a fold-win pot.
    expect(t.hand.vstate.declared).toEqual({ p1: 'out', p2: 'out' });
    expect(t.state.events.filter((e) => e.type === 'pot-matched')).toHaveLength(0);
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('all-out is impossible: the hand ends at 1 remaining, before the last declare', () => {
    const t = gutsTable(2); // order [p1, p0]
    checkAround(t);
    declare(t, 'p1', 'out');
    expect(t.state.phase).toBe('hand-over'); // p0 already won
    expect(t.stack('p0')).toBe(21);
    // There is no turn left in which p0 could ever declare out.
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p0', move: { kind: 'declare', choice: 'out' } }),
      'bad-phase'
    );
    expect(t.totalChips()).toBe(40);
  });

  it('a lone IN player among droppers wins without showdown or matching', () => {
    const t = gutsTable(); // order [p1, p2, p0]
    checkAround(t);
    declare(t, 'p1', 'out');
    declare(t, 'p2', 'in');
    declare(t, 'p0', 'out');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0].winners).toEqual(['p2']);
    expect(t.stack('p2')).toBe(22);
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('a carried pot rides along: the last player standing takes antes + carry', () => {
    const t = gutsTable();
    // Hand 1: all in, p1 wins 3, p0/p2 each match 3 -> carry 6.
    t.rig({ p1: ['9s', '9d', '9h'], p2: ['2s', '7d', 'Jh'], p0: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.state.carryPot).toBe(6);
    // Hand 2 (order [p2, p0, p1]): both early players drop.
    t.nextHand();
    expect(t.hand.pot).toBe(6);
    const before = t.stack('p1');
    checkAround(t);
    declare(t, 'p2', 'out');
    declare(t, 'p0', 'out');
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(before + 3 + 6); // (post-ante stack) + antes + carried fund
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Pot matching (settle hook)
// ---------------------------------------------------------------------------

describe('pot matching', () => {
  it('every IN loser matches the pot into carryPot', () => {
    const t = gutsTable();
    t.rig({ p1: ['9s', '9d', '9h'], p2: ['2s', '7d', 'Jh'], p0: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(22); // won the 3-chip pot
    expect(t.stack('p2')).toBe(16); // 20 - 1 ante - 3 match
    expect(t.stack('p0')).toBe(16);
    expect(t.state.carryPot).toBe(6);
    const matched = t.state.events.filter((e) => e.type === 'pot-matched');
    expect(matched.map((e) => e.data)).toEqual([
      { playerId: 'p2', amount: 3 },
      { playerId: 'p0', amount: 3 },
    ]);
    expect(t.totalChips()).toBe(60);
  });

  it('a short-stacked loser matches only what they have (table stakes) and busts', () => {
    const t = gutsTable(3, { ante: 5 }, [40, 20, 6]);
    // Antes: p0 35, p1 15, p2 1. Pot 15.
    t.rig({ p1: ['9s', '9d', '9h'], p2: ['2s', '7d', 'Jh'], p0: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.stack('p1')).toBe(30); // 15 + the 15-chip pot
    expect(t.stack('p0')).toBe(20); // 35 - 15 match
    expect(t.stack('p2')).toBe(0); // owed 15, had 1 — capped
    expect(t.state.players['p2'].status).toBe('busted');
    expect(t.state.carryPot).toBe(16); // 15 + 1
    const matched = t.state.events.filter((e) => e.type === 'pot-matched');
    expect(matched.map((e) => e.data)).toEqual([
      { playerId: 'p2', amount: 1 },
      { playerId: 'p0', amount: 15 },
    ]);
    expect(t.totalChips()).toBe(66);
  });

  it('the pot snowballs across hands: match -> bigger pot -> match again', () => {
    const t = gutsTable();
    // Hand 1: p1 wins 3; p2/p0 match -> carry 6.
    t.rig({ p1: ['9s', '9d', '9h'], p2: ['2s', '7d', 'Jh'], p0: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.state.carryPot).toBe(6);
    expect(t.totalChips()).toBe(60);

    // Hand 2 (order [p2, p0, p1]): pot = 3 antes + carried 6 = 9.
    t.nextHand();
    expect(t.hand.pot).toBe(6);
    expect(t.state.carryPot).toBe(0);
    t.rig({ p2: ['As', 'Ad', 'Ah'], p0: ['2s', '7d', 'Jh'], p1: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.hand.result!.pots[0].amount).toBe(9); // antes + carried fund
    expect(t.stack('p2')).toBe(24); // 16 - 1 + 9
    expect(t.stack('p0')).toBe(6); // 16 - 1 - 9
    expect(t.stack('p1')).toBe(12); // 22 - 1 - 9
    expect(t.state.carryPot).toBe(18);
    expect(t.totalChips()).toBe(60);

    // Hand 3: the snowball seeds the next pot.
    t.nextHand();
    expect(t.hand.pot).toBe(18);
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('the carried pot rides into the NEXT game whatever the dealer calls', () => {
    const t = new Table(3, { config: { enabledVariants: ['guts', 'holdem'] } });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'guts' });
    t.rig({ p1: ['9s', '9d', '9h'], p2: ['2s', '7d', 'Jh'], p0: ['3c', '8d', 'Qh'] });
    declareAll(t, 'in');
    expect(t.state.carryPot).toBe(6);
    t.nextHand();
    t.apply({ type: 'chooseGame', playerId: t.state.choosing!.dealerId, variant: 'holdem' });
    expect(t.hand.pot).toBe(6); // the guts matches ride on the hold'em hand
    const stacksBefore = Object.fromEntries(
      Object.values(t.state.players).map((p) => [p.id, p.stack])
    );
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(0); // hold'em has no settle hook
    const gained = Object.values(t.state.players)
      .map((p) => p.stack - stacksBefore[p.id])
      .filter((d) => d > 0)
      .reduce((a, b) => a + b, 0);
    expect(gained).toBe(3 + 6); // 3 antes + the carried 6
    expect(t.totalChips()).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Timeout + validation
// ---------------------------------------------------------------------------

describe('timeout and validation', () => {
  it('timing out on the declare auto-declares OUT and marks the player away', () => {
    const t = gutsTable();
    checkAround(t);
    t.now = t.hand.round.actionDeadline! + t.state.players['p1'].timeBankMs + 1;
    t.apply({ type: 'timeout' }); // arms the time bank first
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.hand.folded).toEqual(['p1']);
    const ev = t.state.events.filter((e) => e.type === 'declared').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p1', choice: 'out' });
    expect(t.toAct).toBe('p2');
    expect(t.totalChips()).toBe(60);
  });

  it('rejects declares out of turn and non-declare moves', () => {
    const t = gutsTable();
    checkAround(t);
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'declare', choice: 'in' } }),
      'not-your-turn'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0] } }),
      'illegal-move'
    );
    expectError(
      t.tryApply({
        type: 'variantMove',
        playerId: 'p1',
        move: { kind: 'declare', choice: 'maybe' as 'in' },
      }),
      'illegal-move'
    );
    expect(t.toAct).toBe('p1'); // nothing consumed the turn
  });

  it('betting moves are rejected during the declare round', () => {
    const t = gutsTable();
    checkAround(t);
    expectError(t.tryAct('p1', 'check'), 'illegal-move');
    expectError(t.tryAct('p1', 'bet', 5), 'illegal-move');
  });
});

// ---------------------------------------------------------------------------
// Pre-declare betting round (house rule 2026-08-01)
// ---------------------------------------------------------------------------

describe('pre-declare betting round', () => {
  it('deal opens a check-or-bet street; checking around reaches the declares', () => {
    const t = gutsTable();
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet' });
    expect(t.toAct).toBe('p1'); // left of the dealer, like every street
    const legal = getLegalActions(t.state, 'p1')!;
    expect(legal).toMatchObject({ kind: 'betting', canCheck: true, canBet: true });
    checkAround(t);
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'declare' });
    expect(t.toAct).toBe('p1');
  });

  it('a bet must be called to declare; folders sit out the declare walk', () => {
    const t = gutsTable();
    t.act('p1', 'bet', 4);
    t.act('p2', 'fold');
    t.act('p0', 'call');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'declare' });
    expect(t.hand.folded).toContain('p2');
    declare(t, 'p1', 'in');
    expect(t.toAct).toBe('p0'); // straight past folded p2
  });

  it('losers match the RAISED pot — betting escalates the stakes', () => {
    const t = gutsTable(3, { ante: 2 }, [40, 40, 40]);
    t.rig({
      p1: ['Qs', 'Qd', 'Qh'], // trips — wins
      p2: ['9s', '9d', '4h'],
      p0: ['2c', '7d', '5s'],
    });
    // Antes 6; p1 bets 4, both call — pot 18.
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p0', 'call');
    declare(t, 'p1', 'in');
    declare(t, 'p2', 'in');
    declare(t, 'p0', 'out');
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(52); // 40 - 2 - 4 + 18
    expect(t.stack('p2')).toBe(16); // 40 - 2 - 4 - 18 matched
    expect(t.stack('p0')).toBe(34); // 40 - 2 - 4, out — bet is dead money
    expect(t.state.carryPot).toBe(18); // the match seeds the next pot
    expect(t.totalChips()).toBe(120);
  });

  it('everyone folding to a bet is a fold-win: no declares, no matching', () => {
    const t = gutsTable();
    t.act('p1', 'bet', 4);
    t.act('p2', 'fold');
    t.act('p0', 'fold');
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(22); // 20 - 1 ante + 3 antes; uncalled bet back
    expect(t.state.carryPot).toBe(0);
    const types = t.state.events.map((e) => e.type);
    expect(types).not.toContain('declared');
    expect(types).not.toContain('pot-matched');
    expect(t.totalChips()).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Bot policy
// ---------------------------------------------------------------------------

describe('bot policy', () => {
  function view(
    hole: string[],
    potTotal: number,
    stack: number,
    personality: Partial<BotPersonality> = {}
  ): BotView {
    return {
      hole,
      board: [],
      publicCards: {},
      potTotal,
      stack,
      committed: 0,
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'declare' }],
        autoMove: { kind: 'declare', choice: 'out' },
      },
      activeCount: 3,
      personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1, ...personality },
      minBet: 2,
    };
  }

  function decide(v: BotView): VariantMoveInput {
    return guts.bot.decideExchange!(v, zeroRand);
  }

  /** A betting-round view: open action or facing a bet of `callAmount`. */
  function betView(
    hole: string[],
    potTotal: number,
    stack: number,
    callAmount = 0,
    personality: Partial<BotPersonality> = {}
  ): BotView {
    return {
      ...view(hole, potTotal, stack, personality),
      legal: {
        kind: 'betting',
        canFold: true,
        canCheck: callAmount === 0,
        callAmount,
        canBet: callAmount === 0,
        canRaise: callAmount > 0,
        minRaiseTo: callAmount === 0 ? 2 : callAmount + 2,
        maxRaiseTo: stack,
      },
    };
  }

  it('betting brain: strong hands bet when checked to, junk checks behind', () => {
    const strong = guts.bot.decideBet(betView(['Qs', 'Qd', 'Qh'], 6, 20), zeroRand);
    expect(strong.move).toBe('bet');
    expect(strong.amount).toBeGreaterThanOrEqual(2);
    expect(guts.bot.decideBet(betView(['7s', '4d', '2h'], 6, 20), zeroRand)).toEqual({
      move: 'check',
    });
  });

  it('betting brain: junk folds to a bet, a monster continues', () => {
    expect(guts.bot.decideBet(betView(['7s', '4d', '2h'], 10, 20, 4), zeroRand).move).toBe('fold');
    const monster = guts.bot.decideBet(betView(['Qs', 'Qd', 'Qh'], 10, 20, 4), zeroRand);
    expect(['call', 'raise']).toContain(monster.move);
  });

  it('gutsStrength orders hands sensibly', () => {
    const junk = gutsStrength(['7s', '4d', '2h']);
    const kingHigh = gutsStrength(['Ks', '9d', '5h']);
    const lowPair = gutsStrength(['3s', '3d', '7h']);
    const acePair = gutsStrength(['As', 'Ad', 'Kh']);
    const trips = gutsStrength(['9s', '9d', '9h']);
    expect(junk).toBeLessThan(kingHigh);
    expect(kingHigh).toBeLessThan(lowPair);
    expect(lowPair).toBeLessThan(acePair);
    expect(acePair).toBeLessThan(trips);
    expect(trips).toBeLessThanOrEqual(1);
  });

  it('a pair is in even facing a big matched pot; junk is out even cheap', () => {
    expect(decide(view(['As', 'Ad', 'Kh'], 20, 20))).toEqual({ kind: 'declare', choice: 'in' });
    expect(decide(view(['3s', '3d', '7h'], 3, 20))).toEqual({ kind: 'declare', choice: 'in' });
    expect(decide(view(['7s', '4d', '2h'], 3, 20))).toEqual({ kind: 'declare', choice: 'out' });
    expect(decide(view(['7s', '4d', '2h'], 20, 20))).toEqual({ kind: 'declare', choice: 'out' });
  });

  it('king-high is borderline: in when the risk is small, out when it is huge', () => {
    const kh = ['Ks', '9d', '5h'];
    expect(decide(view(kh, 3, 20))).toEqual({ kind: 'declare', choice: 'in' });
    expect(decide(view(kh, 20, 20))).toEqual({ kind: 'declare', choice: 'out' });
  });

  it('personality shifts the threshold: tight-passive folds what loose-aggressive plays', () => {
    const kh = ['Ks', '9d', '5h'];
    const midRisk = (p: Partial<BotPersonality>) => decide(view(kh, 8, 20, p));
    expect(midRisk({ tightness: 0.9, aggression: 0.1 })).toEqual({
      kind: 'declare',
      choice: 'out',
    });
    expect(midRisk({ tightness: 0.1, aggression: 0.9 })).toEqual({
      kind: 'declare',
      choice: 'in',
    });
  });

  it('is deterministic for a given view', () => {
    const v = view(['Ks', '9d', '5h'], 8, 20);
    const first = decide(v);
    for (let i = 0; i < 5; i++) expect(decide(v)).toEqual(first);
  });
});
