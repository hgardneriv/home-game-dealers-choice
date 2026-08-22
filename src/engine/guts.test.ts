import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError, legalFor, REBUY_CONFIG, zeroRand } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import { chooseDiscards, guts, gutsStrength } from './variants/guts';
import { CATEGORY3, describe3, evaluate3 } from './evaluator3';
import { getLegalActions } from './betting';
import { redactForPlayer } from '@/server/redact';
import type { BotView } from './bot';
import type { BotPersonality, VariantMoveInput } from './types';

/**
 * Three-card guts scenarios. zeroRand geometry: first-hand button = seat 0
 * (p0), hand order [p1, ..., p0], p1 first to act on every round including
 * the draw.
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

function discard(t: Table, playerId: string, cardIndexes: number[]) {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'discard', cardIndexes } });
}

function foldDraw(t: Table, playerId: string) {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'fold' } });
}

/** Check every seat through the current betting street. */
function checkAround(t: Table) {
  let guard = 0;
  while (t.state.phase === 'playing' && t.hand.round.kind === 'betting') {
    if (guard++ > 12) throw new Error('betting street did not close');
    t.act(t.toAct!, 'check');
  }
}

/** Check the first street, then everyone stands pat. */
function standAll(t: Table) {
  checkAround(t);
  while (t.state.phase === 'playing' && t.hand.round.kind === 'exchange') {
    discard(t, t.toAct!, []);
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
// Hand flow: deal → bet → discard → second bet → showdown
// ---------------------------------------------------------------------------

describe('hand flow', () => {
  it('deals three down cards to everyone and opens a betting round', () => {
    const t = gutsTable();
    expect(t.hand.variant).toBe('guts');
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'first' });
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(3);
      expect(t.hand.playerCards[id].faceUp).toEqual([false, false, false]);
    }
    expect(t.hand.board).toEqual([]);
    expect(t.toAct).toBe('p1');
    expect(t.hand.deckPos).toBe(9);
    expect(t.totalChips()).toBe(60);
  });

  it('first betting round closes into the draw; draws close into the second round; then showdown', () => {
    const t = gutsTable();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.toAct).toBe('p1');
    const legal = getLegalActions(t.state, 'p1')!;
    expect(legal).toMatchObject({
      kind: 'exchange',
      moves: [{ kind: 'discard', min: 0, max: 2 }, { kind: 'fold' }],
      autoMove: { kind: 'discard', cardIndexes: [] },
    });

    discard(t, 'p1', [0, 1]);
    discard(t, 'p2', []);
    discard(t, 'p0', [2]);

    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'second' });
    expect(t.hand.discards).toHaveLength(3);
    expect(t.hand.deckPos).toBe(12); // 9 dealt + 3 replacements
    expect(t.hand.playerCards['p1'].cards).toHaveLength(3);

    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('cards-drawn events are public and name only counts', () => {
    const t = gutsTable();
    checkAround(t);
    discard(t, 'p1', [1, 2]);
    const ev = t.state.events.filter((e) => e.type === 'cards-drawn').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p1', count: 2 });
  });

  it('worst case six players drawing two never exhausts the deck', () => {
    const t = gutsTable(6);
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p0']) t.act(id, 'check');
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p0']) {
      discard(t, id, [0, 1]);
    }
    expect(t.hand.deckPos).toBe(30); // 18 + 12
    const all = Object.values(t.hand.playerCards).flatMap((pc) => pc.cards);
    expect(new Set(all).size).toBe(18);
    t.checkDown();
    expect(t.totalChips()).toBe(120);
  });

  it('two or more players go to showdown; the best 3-card hand takes the pot', () => {
    const t = gutsTable();
    t.rig({
      p1: ['5s', '5d', 'Kh'], // pair of fives
      p2: ['9s', '9d', '9h'], // trips — winner
      p0: ['2s', '7d', 'Jh'], // junk
    });
    standAll(t);
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots).toEqual([{ amount: 3, winners: ['p2'], eligible: ['p1', 'p2', 'p0'] }]);
    expect(result.descriptions['p2']).toBe('Three of a Kind, Nines');
    expect(result.revealed['p2']).toEqual(['9s', '9d', '9h']);
    expect(t.stack('p2')).toBe(22); // 20 - 1 ante + 3 pot
    expect(t.state.carryPot).toBe(0);
    expect(t.state.events.filter((e) => e.type === 'pot-matched')).toHaveLength(0);
    expect(t.totalChips()).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// Draw validation
// ---------------------------------------------------------------------------

describe('draw validation', () => {
  function atDraw() {
    const t = gutsTable();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    return t;
  }

  it('rejects more than two discards', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1, 2] } }),
      'bad-amount'
    );
  });

  it('rejects duplicate and out-of-range indexes', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [1, 1] } }),
      'bad-amount'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [3] } }),
      'bad-amount'
    );
  });

  it('rejects a draw out of turn and during betting rounds', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'discard', cardIndexes: [] } }),
      'not-your-turn'
    );
    const t2 = gutsTable();
    expectError(
      t2.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } }),
      'illegal-move'
    );
  });

  it('rejects declare moves and betting during the draw', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'declare', choice: 'in' } }),
      'illegal-move'
    );
    expectError(t.tryAct('p1', 'check'), 'illegal-move');
    expectError(t.tryAct('p1', 'bet', 5), 'illegal-move');
  });

  it('a fold during the draw sits the player out of the rest of the hand', () => {
    const t = atDraw();
    foldDraw(t, 'p1');
    expect(t.hand.folded).toEqual(['p1']);
    expect(t.toAct).toBe('p2');
    const ev = t.state.events.filter((e) => e.type === 'action').at(-1)!;
    expect(ev.data).toMatchObject({ playerId: 'p1', move: 'fold', street: 'draw' });
    discard(t, 'p2', []);
    discard(t, 'p0', []);
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'second' });
    expect(t.toAct).toBe('p2'); // folded p1 is skipped
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0].eligible).toEqual(['p2', 'p0']);
    expect(t.hand.folded).toContain('p1');
    expect(t.totalChips()).toBe(60);
  });

  it('folding during the draw when only one opponent remains is a fold-win', () => {
    const t = gutsTable(2);
    t.act('p1', 'check');
    t.act('p0', 'check');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    foldDraw(t, 'p1');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0].winners).toEqual(['p0']);
    expect(t.stack('p0')).toBe(21); // 20 - 1 ante + 2 antes
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(40);
  });

  it('rejects a draw-street fold out of turn', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'fold' } }),
      'not-your-turn'
    );
    expect(t.hand.folded).toEqual([]);
    expect(t.toAct).toBe('p1');
  });

  it('timeout during the draw stands pat and marks the player away', () => {
    const t = atDraw();
    t.now = t.hand.round.actionDeadline! + t.state.players['p1'].timeBankMs + 1;
    t.apply({ type: 'timeout' }); // arms the time bank first
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.hand.playerCards['p1'].cards).toHaveLength(3);
    expect(t.toAct).toBe('p2');
    const ev = t.state.events.filter((e) => e.type === 'cards-drawn').at(-1)!;
    expect(ev.data).toMatchObject({ playerId: 'p1', count: 0 });
  });
});

// ---------------------------------------------------------------------------
// Betting streets + fold-wins
// ---------------------------------------------------------------------------

describe('betting streets', () => {
  it('a bet must be called to reach the draw; folders sit out the draw walk', () => {
    const t = gutsTable();
    t.act('p1', 'bet', 4);
    t.act('p2', 'fold');
    t.act('p0', 'call');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.hand.folded).toContain('p2');
    discard(t, 'p1', []);
    expect(t.toAct).toBe('p0'); // straight past folded p2
  });

  it('everyone folding to a bet is a fold-win: no draw, no matching', () => {
    const t = gutsTable();
    t.act('p1', 'bet', 4);
    t.act('p2', 'fold');
    t.act('p0', 'fold');
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(22); // 20 - 1 ante + 3 antes; uncalled bet back
    expect(t.state.carryPot).toBe(0);
    const types = t.state.events.map((e) => e.type);
    expect(types).not.toContain('cards-drawn');
    expect(types).not.toContain('pot-matched');
    expect(t.totalChips()).toBe(60);
  });

  it('the winner takes the raised pot — no loser matching', () => {
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
    discard(t, 'p1', []);
    discard(t, 'p2', []);
    discard(t, 'p0', []);
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.stack('p1')).toBe(52); // 40 - 2 - 4 + 18
    expect(t.stack('p2')).toBe(34); // 40 - 2 - 4
    expect(t.stack('p0')).toBe(34);
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// All-in interactions
// ---------------------------------------------------------------------------

describe('all-in interactions', () => {
  it('a player all-in from the first betting round still draws', () => {
    const t = new Table(2, {
      config: { ...GUTS, ante: 1, minBet: 2, ...REBUY_CONFIG },
      stacks: [20, 5],
    });
    t.start();
    // Order: [p1, p0], button p0. p1 opens shoving 4 (stack 5 - 1 ante).
    t.act('p1', 'bet', 4);
    t.act('p0', 'call');
    expect(t.hand.allIn).toContain('p1');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.toAct).toBe('p1');
    discard(t, 'p1', [0]);
    discard(t, 'p0', []);
    // p0 alone can bet — second round is skipped straight to showdown.
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.totalChips()).toBe(25);
  });
});

// ---------------------------------------------------------------------------
// Secrecy
// ---------------------------------------------------------------------------

describe('secrecy', () => {
  it('discards and replacement cards never reach any client', () => {
    const t = gutsTable();
    checkAround(t);
    discard(t, 'p1', [0, 1]);
    const thrown = t.hand.discards;
    expect(thrown).toHaveLength(2);
    for (const viewer of ['p0', 'p2', null]) {
      const json = JSON.stringify(redactForPlayer(t.state, viewer));
      for (const card of thrown) expect(json).not.toContain(card);
      for (const card of t.hand.playerCards['p1'].cards) expect(json).not.toContain(card);
      expect(json).not.toContain('"discards"');
    }
    const mine = redactForPlayer(t.state, 'p1');
    expect(mine.hand?.myCards).toEqual(t.hand.playerCards['p1'].cards);
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
        moves: [{ kind: 'discard', min: 0, max: 2 }],
        autoMove: { kind: 'discard', cardIndexes: [] },
      },
      activeCount: 3,
      personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1, ...personality },
      minBet: 2,
    };
  }

  function decide(v: BotView): VariantMoveInput {
    return guts.bot.decideExchange!(v, zeroRand);
  }

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
    // bluffFreq 0 so decideFromStrength's zero-rand bluff path stays off.
    expect(guts.bot.decideBet(betView(['7s', '4d', '2h'], 6, 20, 0, { bluffFreq: 0 }), zeroRand)).toEqual({
      move: 'check',
    });
  });

  it('betting brain: junk folds to a bet, a monster continues', () => {
    expect(
      guts.bot.decideBet(betView(['7s', '4d', '2h'], 10, 20, 4, { bluffFreq: 0 }), zeroRand).move
    ).toBe('fold');
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

  it('decideExchange follows chooseDiscards', () => {
    expect(decide(view(['As', 'Ad', 'Kh'], 6, 20))).toEqual({
      kind: 'discard',
      cardIndexes: chooseDiscards(['As', 'Ad', 'Kh']),
    });
    expect(decide(view(['Qs', 'Qd', 'Qh'], 6, 20))).toEqual({ kind: 'discard', cardIndexes: [] });
  });

  it('is deterministic for a given view', () => {
    const v = view(['Ks', '9d', '5h'], 8, 20);
    const first = decide(v);
    for (let i = 0; i < 5; i++) expect(decide(v)).toEqual(first);
  });
});

describe('bot draw policy (chooseDiscards)', () => {
  it('stands pat on a flush or better', () => {
    expect(chooseDiscards(['2s', '7s', 'Ks'])).toEqual([]);
    expect(chooseDiscards(['4s', '5h', '6d'])).toEqual([]);
    expect(chooseDiscards(['9s', '9h', '9d'])).toEqual([]);
    expect(chooseDiscards(['As', '2s', '3s'])).toEqual([]);
  });
  it('keeps a pair and draws the kicker', () => {
    expect(chooseDiscards(['As', 'Ah', '4d'])).toEqual([2]);
  });
  it('draws one to a two-flush', () => {
    expect(chooseDiscards(['2s', '7s', 'Kd'])).toEqual([2]);
  });
  it('draws one to a two-card straight', () => {
    expect(chooseDiscards(['5s', '6h', 'Kd'])).toEqual([2]);
  });
  it('with nothing keeps the highest and draws two', () => {
    expect(chooseDiscards(['2s', '5h', 'Kd']).sort()).toEqual([0, 1]);
  });
  it('never proposes more than two discards', () => {
    expect(chooseDiscards(['2s', '5h', 'Kd']).length).toBeLessThanOrEqual(2);
    expect(chooseDiscards(['As', 'Ah', '4d']).length).toBeLessThanOrEqual(2);
    expect(chooseDiscards(['As', 'Kd']).length).toBe(0);
  });
});

describe('dealer choice integration', () => {
  it('a dealer can call guts and the whole hand settles', () => {
    const t = new Table(3, { config: { enabledVariants: ['holdem', 'guts'] } });
    t.start();
    expect(t.state.phase).toBe('choosing');
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'guts' });
    expect(t.hand.variant).toBe('guts');
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    for (const id of ['p1', 'p2', 'p0']) discard(t, id, [0]);
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.totalChips()).toBe(60);
    expect(() => legalFor(t.state, 'p0')).toThrow(); // hand over — no one to act
  });
});
