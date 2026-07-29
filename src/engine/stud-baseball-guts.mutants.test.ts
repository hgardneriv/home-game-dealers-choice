import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, legalFor } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import { boardStrength, sevenStud, studStrength, studViewStrength } from './variants/seven-stud';
import { baseball } from './variants/baseball';
import { guts, gutsStrength } from './variants/guts';
import { CATEGORY } from './evaluator';
import { FIVE_OF_A_KIND, evaluateWild } from './evaluator-wild';
import { CATEGORY3, evaluate3 } from './evaluator3';
import type { Card } from './types';

/**
 * Mutation-hardening scenarios for seven-stud, baseball, guts, and the wild /
 * three-card evaluators. Each test pins an exact behavior a surviving Stryker
 * mutant could bend: sort/tie-break order (asserted from BOTH insertion
 * orders, since a broken comparator degrades to keep-insertion-order), exact
 * packed scores, event payloads, error messages, and flip/settle choreography.
 */

let cleanup: (() => void)[] = [];
beforeEach(() => {
  cleanup = [
    _registerVariantForTest(sevenStud),
    _registerVariantForTest(baseball),
    _registerVariantForTest(guts),
  ];
});
afterEach(() => {
  cleanup.forEach((fn) => fn());
});

/** Same packing as the 5-card evaluators: category << 20, 4-bit kickers. */
const pk = (cat: number, kickers: number[]): number => {
  let score = cat << 20;
  kickers.forEach((k, i) => {
    score |= k << (16 - 4 * i);
  });
  return score;
};

/** evaluator3 packing: category << 20 | r1 << 8 | r2 << 4 | r3. */
const p3 = (cat: number, r1: number, r2 = 0, r3 = 0): number =>
  (cat << 20) | (r1 << 8) | (r2 << 4) | r3;

// ---------------------------------------------------------------------------
// evaluateWild (baseball's wild evaluator)
// ---------------------------------------------------------------------------

describe('evaluateWild exactness', () => {
  it('scores natural partial hands exactly: quads, trips, pair with kickers', () => {
    expect(evaluateWild(['Ks', 'Kh', 'Kd', 'Kc'])).toBe(pk(CATEGORY.quads, [13]));
    expect(evaluateWild(['Ks', 'Kh', 'Kd', '7c'])).toBe(pk(CATEGORY.trips, [13, 7]));
    expect(evaluateWild(['Ks', 'Kd', '7c'])).toBe(pk(CATEGORY.pair, [13, 7]));
    expect(evaluateWild(['Ks', 'Kd', 'Qc', '7h'])).toBe(pk(CATEGORY.pair, [13, 12, 7]));
  });

  it('group order is count-desc then rank-desc regardless of insertion order', () => {
    // Pair below a higher kicker: count ordering decides the category.
    expect(evaluateWild(['Ah', 'Kd', 'Kc'])).toBe(pk(CATEGORY.pair, [13, 14]));
    expect(evaluateWild(['Kd', 'Kc', 'Ah'])).toBe(pk(CATEGORY.pair, [13, 14]));
    // Two pair: rank ordering decides which pair leads.
    expect(evaluateWild(['7c', '7h', 'Kd', 'Ks'])).toBe(pk(CATEGORY.twoPair, [13, 7]));
    expect(evaluateWild(['Ks', 'Kd', '7c', '7h'])).toBe(pk(CATEGORY.twoPair, [13, 7]));
  });

  it('kicker lists are rank-descending regardless of insertion order', () => {
    // One wild, natural pair -> trips; kickers Q then 2, whatever the deal order.
    expect(evaluateWild(['2s', 'Qd', '7h', '7c', '3s'])).toBe(pk(CATEGORY.trips, [7, 12, 2]));
    // One wild, all distinct -> pair the highest; kickers descend.
    expect(evaluateWild(['5s', 'Kd', 'Ah', '7c', '9h'])).toBe(pk(CATEGORY.pair, [14, 13, 7, 5]));
  });

  it('wilds complete the 6-high straight (the bottom non-wheel window)', () => {
    expect(evaluateWild(['2s', '5h', '6d', '3c', '9c'])).toBe(pk(CATEGORY.straight, [6]));
  });

  it('paired naturals can never make a wild straight', () => {
    // K K Q J + wild is trips, NOT a straight through the duplicate king.
    expect(evaluateWild(['Ks', 'Kh', 'Qd', 'Jc', '9s'])).toBe(pk(CATEGORY.trips, [13, 12, 11]));
  });

  it('three wilds turn one natural pair-less rank into quads with a kicker', () => {
    expect(evaluateWild(['Kd', '7c', '3s', '3h', '9d'])).toBe(pk(CATEGORY.quads, [13, 7]));
  });

  it('all-wild partials ladder up as aces', () => {
    expect(evaluateWild(['3s', '3h', '9d'])).toBe(pk(CATEGORY.trips, [14]));
    expect(evaluateWild(['3s', '3h', '9d', '9c'])).toBe(pk(CATEGORY.quads, [14]));
  });

  it('five wilds and five-of-a-kind stay above every straight flush', () => {
    expect(evaluateWild(['3s', '3h', '3d', '3c', '9s'])).toBe(pk(FIVE_OF_A_KIND, [14]));
    expect(pk(FIVE_OF_A_KIND, [2])).toBeGreaterThan(pk(CATEGORY.straightFlush, [14]));
  });
});

// ---------------------------------------------------------------------------
// evaluate3 (guts)
// ---------------------------------------------------------------------------

describe('evaluate3 exactness', () => {
  it('K-3-2 is a high card, not a wheel (the wheel needs the ace)', () => {
    expect(evaluate3(['Ks', '3d', '2h'])).toBe(p3(CATEGORY3.highCard, 13, 3, 2));
    expect(evaluate3(['As', '3d', '2h'])).toBe(p3(CATEGORY3.straight, 3));
  });

  it('straights are detected from ascending deal order (ranks sort desc)', () => {
    expect(evaluate3(['2s', '3d', '4h'])).toBe(p3(CATEGORY3.straight, 4));
    expect(evaluate3(['4s', '2d', '3h'])).toBe(p3(CATEGORY3.straight, 4));
  });

  it('a pair packs pair rank then kicker, exactly', () => {
    expect(evaluate3(['Ks', 'Kd', '7h'])).toBe(p3(CATEGORY3.pair, 13, 7));
    expect(evaluate3(['5s', 'Ah', '5d'])).toBe(p3(CATEGORY3.pair, 5, 14));
  });

  it('the wrong-arity error names the requirement and the count', () => {
    expect(() => evaluate3(['As', 'Kd'])).toThrow('evaluate3 needs 3 cards, got 2');
  });
});

// ---------------------------------------------------------------------------
// seven-stud: boardStrength / firstToAct / streets
// ---------------------------------------------------------------------------

const STUD = { enabledVariants: ['seven-stud'] as ['seven-stud'] };

function studTable(players = 3): Table {
  const t = new Table(players, { config: STUD });
  t.start();
  return t;
}

/** Plant a player's stud cards with an explicit down/up split. */
function setCards(t: Table, id: string, down: Card[], up: Card[]): void {
  t.hand.playerCards[id] = {
    cards: [...down, ...up],
    faceUp: [...down.map(() => false), ...up.map(() => true)],
  };
}

function studEvents(t: Table) {
  return t.state.events
    .filter((e) => e.type === 'stud-street')
    .map((e) => e.data as { street: string; upCards: Record<string, Card> });
}

describe('seven-stud boardStrength packing', () => {
  it('an empty board scores exactly zero', () => {
    expect(boardStrength([])).toBe(0);
  });

  it('packs high-card boards rank-descending from either insertion order', () => {
    const expected = pk(CATEGORY.highCard, [14, 13]);
    expect(boardStrength(['Ah', 'Kh'])).toBe(expected);
    expect(boardStrength(['Kh', 'Ah'])).toBe(expected);
  });

  it('packs a pair ahead of a higher kicker from either insertion order', () => {
    const expected = pk(CATEGORY.pair, [7, 14]);
    expect(boardStrength(['Ah', '7h', '7d'])).toBe(expected);
    expect(boardStrength(['7h', '7d', 'Ah'])).toBe(expected);
  });

  it('packs two pair high-pair-first from either insertion order', () => {
    const expected = pk(CATEGORY.twoPair, [13, 7]);
    expect(boardStrength(['7c', '7h', 'Kd', 'Ks'])).toBe(expected);
    expect(boardStrength(['Ks', 'Kd', '7c', '7h'])).toBe(expected);
  });

  it('packs trips and quads exactly', () => {
    expect(boardStrength(['9s', '9h', '9d', '2c'])).toBe(pk(CATEGORY.trips, [9, 2]));
    expect(boardStrength(['5s', '5h', '5d', '5c'])).toBe(pk(CATEGORY.quads, [5]));
  });
});

describe('seven-stud table rules', () => {
  it('fits exactly 2 through 6 players', () => {
    expect(sevenStud.fitsPlayers(1)).toBe(false);
    expect(sevenStud.fitsPlayers(2)).toBe(true);
    expect(sevenStud.fitsPlayers(6)).toBe(true);
    expect(sevenStud.fitsPlayers(7)).toBe(false);
  });

  it('emits stud-street events named third..seventh, with correct fifth/sixth up-cards', () => {
    const t = studTable(3);
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const events = studEvents(t);
    expect(events.map((e) => e.street)).toEqual(['third', 'fourth', 'fifth', 'sixth', 'seventh']);
    for (const id of ['p0', 'p1', 'p2']) {
      expect(events[2].upCards[id]).toBe(t.hand.playerCards[id].cards[4]);
      expect(events[3].upCards[id]).toBe(t.hand.playerCards[id].cards[5]);
    }
    expect(events[4].upCards).toEqual({});
  });

  it('firstToAct ignores folded players even when their board is best', () => {
    const t = studTable(3);
    setCards(t, 'p1', ['2c', '7d'], ['Ah', 'Kd']);
    setCards(t, 'p2', ['4c', '8d'], ['9s', '9h']); // best showing board, but folded
    setCards(t, 'p0', ['5c', '6d'], ['Qh', 'Jc']);
    t.hand.folded.push('p2');
    expect(sevenStud.firstToAct!(t.state, t.hand)).toBe('p1');
  });

  it('an opponent board of merely EQUAL category triggers no discount', () => {
    const hole: Card[] = ['As', 'Ah', '4d'];
    expect(studViewStrength({ hole, publicCards: { v: ['Ks', 'Kh'] } })).toBe(studStrength(hole));
  });
});

// ---------------------------------------------------------------------------
// baseball: flip choreography, events, errors
// ---------------------------------------------------------------------------

const BASEBALL = { enabledVariants: ['baseball'] as ['baseball'] };

/** No wilds, no pairs/straights/flushes at any prefix; flips Kd first. */
const P1 = ['Kd', '2c', '4h', '5s', '7d', '8c', 'Jh'];
/** Pair of queens after two flips. */
const P2 = ['Qs', 'Qh', '6h', '2d', '8h', 'Jc', '5d'];
/** Pair of aces after two flips. */
const P0 = ['As', 'Ad', '3s', '3h', '9c', 'Kh', '5h'];
/** Seven cards that never beat even ace-high. */
const BUST = ['2s', '4c', '5c', '7h', '8s', 'Th', 'Qd'];

function rig7(t: Table, hands: Record<string, string[]>): void {
  for (const [id, cards] of Object.entries(hands)) {
    t.hand.playerCards[id] = { cards: [...cards], faceUp: cards.map(() => false) };
  }
}

function flip(t: Table, id: string): void {
  t.apply({ type: 'variantMove', playerId: id, move: { kind: 'flip' } });
}

function checkRound(t: Table): void {
  const street = t.hand.round.street;
  let guard = 0;
  while (
    t.state.phase === 'playing' &&
    t.hand.round.kind === 'betting' &&
    t.hand.round.street === street
  ) {
    if (guard++ > 20) throw new Error('betting round did not close');
    const id = t.toAct!;
    const legal = legalFor(t.state, id);
    t.act(id, legal.canCheck ? 'check' : 'call');
  }
}

function riggedBaseball(): Table {
  const t = new Table(3, { config: BASEBALL });
  t.start();
  rig7(t, { p1: P1, p2: P2, p0: P0 });
  return t;
}

function lastAction(t: Table) {
  return t.state.events.filter((e) => e.type === 'action').at(-1)!.data;
}

describe('baseball rules', () => {
  it('fits exactly 2 through 6 players', () => {
    expect(baseball.fitsPlayers(1)).toBe(false);
    expect(baseball.fitsPlayers(2)).toBe(true);
    expect(baseball.fitsPlayers(6)).toBe(true);
    expect(baseball.fitsPlayers(7)).toBe(false);
  });

  it('a beating flip logs an action with the card and beat flag', () => {
    const t = riggedBaseball();
    flip(t, 'p1');
    expect(lastAction(t)).toEqual({
      playerId: 'p1',
      move: 'flip',
      detail: { card: 'Kd', beat: true },
      street: 'flip',
      auto: false,
    });
  });

  it('a non-beating flip logs the card only and the turn continues', () => {
    const t = riggedBaseball();
    flip(t, 'p1');
    checkRound(t);
    flip(t, 'p2'); // Qs: queen-high does not beat king-high
    expect(lastAction(t)).toEqual({
      playerId: 'p2',
      move: 'flip',
      detail: { card: 'Qs' },
      street: 'flip',
      auto: false,
    });
    expect(t.toAct).toBe('p2');
    expect(t.hand.round.kind).toBe('exchange');
  });

  it('busting logs the final card with busted:true and a busted-out payload', () => {
    const t = new Table(2, { config: BASEBALL });
    t.start(); // order [p1, p0]
    rig7(t, { p1: ['Ah', 'Kc', '6d', 'Jd', '7c', '2h', '4s'], p0: BUST });
    flip(t, 'p1');
    checkRound(t);
    for (let i = 0; i < 7; i++) flip(t, 'p0');
    expect(lastAction(t)).toEqual({
      playerId: 'p0',
      move: 'flip',
      detail: { card: 'Qd', busted: true },
      street: 'flip',
      auto: false,
    });
    const busted = t.state.events.filter((e) => e.type === 'busted-out').at(-1)!;
    expect(busted.data).toEqual({ playerId: 'p0' });
  });

  it('the hand to beat comes from ACTIVE players only — folded boards do not count', () => {
    const t = riggedBaseball();
    flip(t, 'p1'); // Kd
    checkRound(t); // bet-1
    flip(t, 'p2'); // Qs
    flip(t, 'p2'); // Qh — pair of queens, best visible
    expect(t.hand.round.street).toBe('bet-2');
    t.act('p2', 'bet', 2);
    t.act('p0', 'raise', 4);
    t.act('p1', 'call');
    t.act('p2', 'fold'); // the pair of queens leaves the hand
    // p0's flip turn: only p1's king-high is live, so one ace ends the turn.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p0');
    flip(t, 'p0'); // As
    expect(t.hand.playerCards['p0'].faceUp.filter(Boolean)).toHaveLength(1);
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-3' });
  });

  it('firstToAct returns exactly null when every seat from the cursor is folded', () => {
    const t = riggedBaseball();
    t.hand.folded.push('p1', 'p2', 'p0');
    expect(baseball.firstToAct!(t.state, t.hand)).toBe(null);
  });

  it('rejects a non-flip move with the exact message', () => {
    const t = riggedBaseball();
    const res = t.tryApply({
      type: 'variantMove',
      playerId: 'p1',
      move: { kind: 'discard', cardIndexes: [] },
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('illegal-move');
      expect(res.error.message).toBe('Expected a flip');
    }
  });

  it('rejects a flip when all seven cards are already up', () => {
    const t = riggedBaseball();
    t.hand.playerCards['p1'].faceUp = Array(7).fill(true);
    const res = t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'flip' } });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('illegal-move');
      expect(res.error.message).toBe('No cards left to flip');
    }
  });
});

// ---------------------------------------------------------------------------
// guts: declare validation, events, settle
// ---------------------------------------------------------------------------

const GUTS = { enabledVariants: ['guts'] as ['guts'] };

function gutsTable(players = 3): Table {
  const t = new Table(players, { config: GUTS });
  t.start();
  return t;
}

function declare(t: Table, playerId: string, choice: 'in' | 'out') {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'declare', choice } });
}

describe('guts rules', () => {
  it('fits exactly 2 through 6 players', () => {
    expect(guts.fitsPlayers(1)).toBe(false);
    expect(guts.fitsPlayers(2)).toBe(true);
    expect(guts.fitsPlayers(6)).toBe(true);
    expect(guts.fitsPlayers(7)).toBe(false);
  });

  it('rejects wrong move kinds and bad choices with their exact messages', () => {
    const t = gutsTable();
    const wrongKind = t.tryApply({
      type: 'variantMove',
      playerId: 'p1',
      move: { kind: 'discard', cardIndexes: [0] },
    });
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) {
      expect(wrongKind.error.message).toBe('Expected an in/out declaration');
    }
    const badChoice = t.tryApply({
      type: 'variantMove',
      playerId: 'p1',
      move: { kind: 'declare', choice: 'maybe' as 'in' },
    });
    expect(badChoice.ok).toBe(false);
    if (!badChoice.ok) {
      expect(badChoice.error.message).toBe('Declare in or out');
    }
  });

  it('a declare logs an action naming the choice in move and detail', () => {
    const t = gutsTable();
    declare(t, 'p1', 'in');
    const action = t.state.events.filter((e) => e.type === 'action').at(-1)!.data;
    expect(action).toEqual({
      playerId: 'p1',
      move: 'declare in',
      detail: { choice: 'in' },
      street: 'declare',
      auto: false,
    });
  });

  it('with exactly TWO contenders the loser still matches the pot', () => {
    const t = gutsTable();
    t.rig({
      p1: ['2s', '7d', 'Jh'],
      p2: ['9s', '9d', '9h'], // winner
      p0: ['4c', '8d', 'Qh'], // loser — must match
    });
    declare(t, 'p1', 'out');
    declare(t, 'p2', 'in');
    declare(t, 'p0', 'in');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 3, winners: ['p2'] });
    expect(t.stack('p2')).toBe(22); // 20 - 1 ante + 3 pot
    expect(t.stack('p0')).toBe(16); // 20 - 1 ante - 3 match
    expect(t.stack('p1')).toBe(19); // dropped: ante only
    expect(t.state.carryPot).toBe(3);
    const matched = t.state.events.filter((e) => e.type === 'pot-matched');
    expect(matched.map((e) => e.data)).toEqual([{ playerId: 'p0', amount: 3 }]);
    expect(t.totalChips()).toBe(60);
  });

  it('gutsStrength covers every category in order, kickers breaking ties upward', () => {
    const highCard = gutsStrength(['7s', '4d', '2h']);
    const pair = gutsStrength(['5s', '5d', '2h']);
    const flush = gutsStrength(['2s', '5s', '9s']);
    const straight = gutsStrength(['4s', '5d', '6h']);
    const trips = gutsStrength(['9s', '9d', '9h']);
    const straightFlush = gutsStrength(['4s', '5s', '6s']);
    expect(highCard).toBeGreaterThan(0);
    expect(highCard).toBeLessThan(pair);
    expect(pair).toBeLessThan(flush);
    expect(flush).toBeLessThan(straight);
    expect(straight).toBeLessThan(trips);
    expect(trips).toBeLessThan(straightFlush);
    expect(straightFlush).toBeLessThanOrEqual(1);
    // The fine tie-break ADDS: a better kicker means a stronger hand.
    expect(gutsStrength(['5s', '5d', 'Kh'])).toBeGreaterThan(gutsStrength(['5c', '5h', '2d']));
  });
});
