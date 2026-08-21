import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError, legalFor, zeroRand, REBUY_CONFIG } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import { baseball } from './variants/baseball';
import { FIVE_OF_A_KIND, beatsVisible, describeWild, evaluateWild } from './evaluator-wild';
import { CATEGORY, evaluate5 } from './evaluator';
import { getLegalActions } from './betting';
import { buildBotView } from './bot';
import { redactForPlayer } from '@/server/redact';

/**
 * Baseball (7-card no-peek, wild 3s and 9s). zeroRand geometry: first-hand
 * button = seat 0 (p0); 3-player hand order [p1, p2, p0]; 2-player [p1, p0].
 * Hands are rigged by writing hand.playerCards directly after the deal — the
 * deck is fully consumed at deal time, so nothing else needs rigging.
 */

let cleanup: (() => void) | null = null;
beforeEach(() => {
  cleanup = _registerVariantForTest(baseball);
});
afterEach(() => {
  cleanup?.();
});

const BASEBALL = { enabledVariants: ['baseball'] as ['baseball'] };

/** No wilds, no pairs/straights/flushes at any prefix; flips Kd first. */
const P1 = ['Kd', '2c', '4h', '5s', '7d', '8c', 'Jh'];
/** Pair of queens after two flips. */
const P2 = ['Qs', 'Qh', '6h', '2d', '8h', 'Jc', '5d'];
/** Pair of aces after two flips; five aces (A A + wilds 3s 3h 9c) at showdown. */
const P0 = ['As', 'Ad', '3s', '3h', '9c', 'Kh', '5h'];
/** Seven cards that never beat even ace-high: Q-high junk, no pair/wild/straight/flush. */
const BUST = ['2s', '4c', '5c', '7h', '8s', 'Th', 'Qd'];

function rig7(t: Table, hands: Record<string, string[]>): void {
  for (const [id, cards] of Object.entries(hands)) {
    t.hand.playerCards[id] = { cards: [...cards], faceUp: cards.map(() => false) };
  }
}

function flip(t: Table, id: string): void {
  t.apply({ type: 'variantMove', playerId: id, move: { kind: 'flip' } });
}

/** Check/call the current betting round closed. */
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

function riggedTable(): Table {
  const t = new Table(3, { config: BASEBALL });
  t.start();
  rig7(t, { p1: P1, p2: P2, p0: P0 });
  return t;
}

const pk = (cat: number, kickers: number[]): number => {
  let score = cat << 20;
  kickers.forEach((k, i) => (score |= k << (16 - 4 * i)));
  return score;
};

// ---------------------------------------------------------------------------

describe('evaluateWild', () => {
  it('scores five of a kind above a straight flush', () => {
    expect(evaluateWild(['As', 'Ah', 'Ad', '3s', '9h'])).toBe(pk(FIVE_OF_A_KIND, [14]));
    expect(evaluateWild(['7s', '7h', '3d', '9c', '7d'])).toBe(pk(FIVE_OF_A_KIND, [7]));
    // Even five twos outrank a royal flush.
    expect(pk(FIVE_OF_A_KIND, [2])).toBeGreaterThan(evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts']));
  });

  it('all five wilds make five aces', () => {
    expect(evaluateWild(['3s', '3h', '3d', '3c', '9s'])).toBe(pk(FIVE_OF_A_KIND, [14]));
  });

  it('wilds complete straight flushes at the highest window', () => {
    // 5s 6s 8s + two wilds -> 5..9 straight flush (not 8-high).
    expect(evaluateWild(['5s', '6s', '3h', '8s', '9d'])).toBe(pk(CATEGORY.straightFlush, [9]));
  });

  it('wilds complete straights, including the wheel', () => {
    expect(evaluateWild(['4s', '5h', '6d', '8c', '9c'])).toBe(pk(CATEGORY.straight, [8]));
    expect(evaluateWild(['As', '2h', '4d', '5c', '9h'])).toBe(pk(CATEGORY.straight, [5]));
  });

  it('wilds complete quads with a natural kicker', () => {
    expect(evaluateWild(['Ks', 'Kh', 'Kd', '3c', '7s'])).toBe(pk(CATEGORY.quads, [13, 7]));
    expect(evaluateWild(['Qs', 'Qh', '3d', '9c', 'As'])).toBe(pk(CATEGORY.quads, [12, 14]));
  });

  it('two natural pairs plus a wild make a full house', () => {
    expect(evaluateWild(['Ks', 'Kh', '7d', '7c', '3s'])).toBe(pk(CATEGORY.fullHouse, [13, 7]));
  });

  it('wilds in a flush play as aces', () => {
    expect(evaluateWild(['Kh', '7h', '4h', '3s', '9d'])).toBe(
      pk(CATEGORY.flush, [14, 14, 13, 7, 4])
    );
  });

  it('wilds make the highest trips or pair when nothing bigger fits', () => {
    expect(evaluateWild(['Ah', 'Kd', '2c', '3s', '9h'])).toBe(pk(CATEGORY.trips, [14, 13, 2]));
    expect(evaluateWild(['Ah', 'Kd', '7c', '5s', '9h'])).toBe(pk(CATEGORY.pair, [14, 13, 7, 5]));
  });

  it('matches evaluate5 exactly on natural five-card hands', () => {
    for (const hand of [
      ['As', 'Kd', '8c', '6h', '2s'],
      ['4s', '5h', '6d', '7c', '8s'],
      ['Ks', 'Kh', '7d', '7c', '2s'],
      ['2s', '7s', 'Ts', 'Js', 'As'],
    ]) {
      expect(evaluateWild(hand)).toBe(evaluate5(hand));
    }
  });

  it('evaluates partial hands: ladders with wilds as the best duplicate', () => {
    expect(evaluateWild([])).toBe(0);
    expect(evaluateWild(['Kd'])).toBe(pk(CATEGORY.highCard, [13]));
    expect(evaluateWild(['3s'])).toBe(pk(CATEGORY.highCard, [14])); // lone wild = ace
    expect(evaluateWild(['2c', '7d'])).toBe(pk(CATEGORY.highCard, [7, 2]));
    expect(evaluateWild(['3s', 'Kd'])).toBe(pk(CATEGORY.pair, [13]));
    expect(evaluateWild(['9s', '9d'])).toBe(pk(CATEGORY.pair, [14])); // two wilds = pair of aces
    expect(evaluateWild(['3s', 'Ah', 'Ad'])).toBe(pk(CATEGORY.trips, [14]));
    expect(evaluateWild(['Ks', 'Kd', '7c', '7h'])).toBe(pk(CATEGORY.twoPair, [13, 7]));
    expect(evaluateWild(['9s', '9h', '3d', 'Ac'])).toBe(pk(CATEGORY.quads, [14]));
    expect(evaluateWild(['3s', 'Kd', 'Qc', '7h'])).toBe(pk(CATEGORY.pair, [13, 12, 7]));
    expect(evaluateWild(['3s', '9d', 'Qc', '7h'])).toBe(pk(CATEGORY.trips, [12, 7]));
  });

  it('finds the best five of seven with wilds', () => {
    expect(evaluateWild(P0)).toBe(pk(FIVE_OF_A_KIND, [14]));
    expect(evaluateWild(P1)).toBe(pk(CATEGORY.highCard, [13, 11, 8, 7, 5]));
    expect(evaluateWild(BUST)).toBe(pk(CATEGORY.highCard, [12, 10, 8, 7, 5]));
  });

  it('beatsVisible is strict', () => {
    expect(beatsVisible(['Kd'], [])).toBe(true);
    expect(beatsVisible([], [])).toBe(false);
    expect(beatsVisible(['Qs', 'Qh'], ['Kd'])).toBe(true);
    expect(beatsVisible(['Kd'], ['Kh'])).toBe(false); // tie does not beat
  });

  it('describeWild names five of a kind and delegates the rest', () => {
    expect(describeWild(pk(FIVE_OF_A_KIND, [14]))).toBe('Five of a Kind, Aces');
    expect(describeWild(pk(FIVE_OF_A_KIND, [7]))).toBe('Five of a Kind, Sevens');
    expect(describeWild(pk(CATEGORY.pair, [12, 9, 7, 5]))).toBe('Pair of Queens');
    expect(describeWild(pk(CATEGORY.straightFlush, [9]))).toBe('Straight Flush, Nine High');
  });
});

// ---------------------------------------------------------------------------

describe('deal and first flip', () => {
  it('deals seven cards all face down and opens a flip round for first in hand order', () => {
    const t = new Table(3, { config: BASEBALL });
    t.start();
    expect(t.hand.variant).toBe('baseball');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p1');
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(7);
      expect(t.hand.playerCards[id].faceUp).toEqual(Array(7).fill(false));
    }
    expect(t.hand.deckPos).toBe(21);
    expect(t.hand.board).toEqual([]);
    const legal = getLegalActions(t.state, 'p1')!;
    expect(legal).toMatchObject({
      kind: 'exchange',
      moves: [{ kind: 'flip' }],
      autoMove: { kind: 'flip' },
    });
    expect(t.totalChips()).toBe(60);
  });

  it('first flipper flips exactly one card, then betting opens with them', () => {
    const t = riggedTable();
    flip(t, 'p1');
    expect(t.hand.playerCards['p1'].faceUp).toEqual([true, ...Array(6).fill(false)]);
    const ev = t.state.events.filter((e) => e.type === 'flipped').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p1', card: 'Kd' });
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-1' });
    expect(t.toAct).toBe('p1'); // only visible hand = best visible hand
    expect(t.totalChips()).toBe(60);
  });
});

describe('flip-to-beat', () => {
  it('a later flipper flips one at a time until strictly beating the board', () => {
    const t = riggedTable();
    flip(t, 'p1'); // Kd
    checkRound(t);
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p2');

    flip(t, 'p2'); // Qs — queen high < king high
    expect(t.toAct).toBe('p2'); // turn continues
    expect(t.hand.round.kind).toBe('exchange');
    expect(t.hand.round.actionDeadline).not.toBeNull(); // fresh clock

    flip(t, 'p2'); // Qh — pair of queens beats king high: exactly 2 flips
    expect(t.hand.playerCards['p2'].faceUp).toEqual([true, true, ...Array(5).fill(false)]);
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-2' });
    expect(t.toAct).toBe('p2'); // best visible opens
  });

  it('rejects flips out of turn and non-flip moves', () => {
    const t = riggedTable();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'flip' } }),
      'not-your-turn'
    );
    expectError(
      t.tryApply({
        type: 'variantMove',
        playerId: 'p1',
        move: { kind: 'discard', cardIndexes: [] },
      }),
      'illegal-move'
    );
    // Betting moves are rejected during a flip round.
    expectError(t.tryAct('p1', 'check'), 'illegal-move');
    // Flips are rejected during betting rounds.
    flip(t, 'p1');
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'flip' } }),
      'illegal-move'
    );
  });

  it('a player who flips all seven without beating the board busts out', () => {
    const t = new Table(3, { config: BASEBALL });
    t.start();
    rig7(t, { p1: P1, p2: BUST, p0: P0 });
    flip(t, 'p1'); // Kd
    checkRound(t);
    expect(t.toAct).toBe('p2');
    for (let i = 0; i < 6; i++) {
      flip(t, 'p2');
      expect(t.toAct).toBe('p2');
    }
    flip(t, 'p2'); // seventh card — Q-high never beats K-high
    expect(t.hand.folded).toContain('p2');
    expect(t.state.events.some((e) => e.type === 'busted-out')).toBe(true);
    // Hand continues between p1 and p0: a betting round follows the flip turn.
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-2' });
    expect(t.toAct).toBe('p1'); // K-high is the best visible ACTIVE hand
    checkRound(t);
    // p0's flip turn: ace-high beats king-high in one flip.
    expect(t.toAct).toBe('p0');
    flip(t, 'p0');
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-3' });
    expect(t.toAct).toBe('p0');
    checkRound(t);
    // The cursor orbits back to p1 (behind, cards in hand) — no early winner.
    expect(t.state.phase).toBe('playing');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p1');
    // P1's junk never catches ace-high: six more flips and they bust out,
    // handing p0 the pot as a fold win — nothing hidden is ever revealed.
    for (let i = 0; i < 6; i++) flip(t, 'p1');
    expect(t.hand.folded).toContain('p1');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0].winners).toEqual(['p0']);
    expect(t.hand.result!.revealed).toEqual({});
    expect(t.totalChips()).toBe(60);
  });

  it('busting the last opponent ends the hand as a fold win (no reveal)', () => {
    const t = new Table(2, { config: BASEBALL });
    t.start(); // order [p1, p0]
    rig7(t, { p1: ['Ah', 'Kc', '6d', 'Jd', '7c', '2h', '4s'], p0: BUST });
    flip(t, 'p1'); // Ah
    checkRound(t);
    expect(t.toAct).toBe('p0');
    for (let i = 0; i < 7; i++) flip(t, 'p0');
    expect(t.hand.folded).toContain('p0');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 2, winners: ['p1'] });
    expect(t.hand.result!.revealed).toEqual({});
    expect(t.totalChips()).toBe(40);
  });
});

describe('betting choreography', () => {
  it('best visible hand opens each betting round; folded pre-turn players are skipped', () => {
    const t = riggedTable();
    flip(t, 'p1'); // Kd
    // bet-1: p1 opens and bets, p2 folds before ever flipping, p0 calls.
    expect(t.toAct).toBe('p1');
    t.act('p1', 'bet', 2);
    t.act('p2', 'fold');
    t.act('p0', 'call');
    // p2 never gets a flip turn — the cursor skips them straight to p0.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p0');
    flip(t, 'p0'); // As — ace high beats king high in one card
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'bet-2' });
    expect(t.toAct).toBe('p0'); // new best visible hand opens
    checkRound(t);
    // p1 is behind with cards in hand — the orbit continues; their junk never
    // beats ace-high, so they flip out and p0 takes it as a fold win.
    expect(t.state.phase).toBe('playing');
    expect(t.toAct).toBe('p1');
    for (let i = 0; i < 6; i++) flip(t, 'p1');
    expect(t.hand.folded).toContain('p1');
    expect(t.state.phase).toBe('hand-over');
    // Antes 3 + bets 4 all go to p0.
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 7, winners: ['p0'] });
    expect(t.stack('p0')).toBe(24);
    expect(t.totalChips()).toBe(60);
  });

  it('firstToAct falls back past all-in/folded holders and breaks ties clockwise', () => {
    const t = riggedTable();
    // Simulate mid-hand visibility directly: p1 shows Kd, p2 shows Qs Qh.
    t.hand.playerCards['p1'].faceUp[0] = true;
    t.hand.playerCards['p2'].faceUp[0] = true;
    t.hand.playerCards['p2'].faceUp[1] = true;
    t.hand.round.kind = 'betting';
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p2'); // best visible
    t.hand.allIn.push('p2');
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p1'); // next best
    t.hand.folded.push('p1');
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p0'); // last actor standing
    t.hand.folded.push('p0');
    expect(baseball.firstToAct!(t.state, t.hand)).toBeNull(); // nobody can act
  });

  it('ties in visible strength go to the first player in hand order', () => {
    const t = riggedTable();
    t.hand.round.kind = 'betting';
    // Nobody has flipped: all visible scores are 0 — clockwise from button wins.
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p1');
  });

  it('flip rounds name the cursor player, skipping folded seats', () => {
    const t = riggedTable();
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p1'); // cursor 0
    t.hand.vstate.flipCursor = 1;
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p2');
    t.hand.folded.push('p2');
    expect(baseball.firstToAct!(t.state, t.hand)).toBe('p0');
  });
});

describe('full hand: orbits, busts, and showdown', () => {
  it('flip turns orbit the table — no winner until everyone left is out of cards', () => {
    const t = riggedTable();
    flip(t, 'p1'); // Kd
    expect(t.hand.round.street).toBe('bet-1');
    checkRound(t);
    flip(t, 'p2');
    flip(t, 'p2'); // pair of queens
    expect(t.hand.round.street).toBe('bet-2');
    expect(t.toAct).toBe('p2');
    checkRound(t);
    flip(t, 'p0'); // As — ace high loses to pair of queens
    expect(t.toAct).toBe('p0');
    flip(t, 'p0'); // Ad — pair of aces takes the lead: exactly 2 flips
    expect(t.hand.round.street).toBe('bet-3');
    expect(t.toAct).toBe('p0');
    checkRound(t);

    // THE BUG (play-testing 2026-07-29): this used to be showdown, declaring
    // p0 the winner off five hidden cards. The orbit must continue: p1 is
    // behind with six cards face down.
    expect(t.state.phase).toBe('playing');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p1');
    for (let i = 0; i < 6; i++) flip(t, 'p1'); // junk — busts out
    expect(t.hand.folded).toContain('p1');
    checkRound(t); // bet-4: p2 and p0
    // p2, behind on pair of queens, flips their remaining five and busts too.
    expect(t.toAct).toBe('p2');
    for (let i = 0; i < 5; i++) flip(t, 'p2');
    expect(t.hand.folded).toContain('p2');
    // Everyone else busted out — p0 wins WITHOUT exposing hidden cards.
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 3, winners: ['p0'] });
    expect(t.hand.result!.revealed).toEqual({});
    expect(t.stack('p0')).toBe(22);
    expect(t.totalChips()).toBe(60);
  });

  it('true showdown: ends only when the beaten players are all-up, leader wins', () => {
    const t = new Table(2, { config: BASEBALL });
    t.start(); // order [p1, p0]
    // p0's SEVENTH card finally beats p1's lone king (K-T high > K high);
    // p1 then retakes the lead with one flip (K-Q high). p0 has no cards
    // left to answer — showdown, and p1's hidden cards count for them.
    rig7(t, {
      p1: ['Kd', 'Qc', '2c', '4h', '5s', '7d', '8c'],
      p0: ['2s', '4c', '5c', '7h', '8s', 'Th', 'Kh'],
    });
    flip(t, 'p1'); // Kd
    checkRound(t);
    for (let i = 0; i < 7; i++) flip(t, 'p0'); // seventh (Kh) takes the lead
    expect(t.hand.folded).not.toContain('p0');
    expect(t.hand.playerCards['p0'].faceUp).toEqual(Array(7).fill(true));
    checkRound(t); // bet-2
    expect(t.toAct).toBe('p1'); // behind K vs K-T — orbit returns to p1
    flip(t, 'p1'); // Qc — K-Q beats K-T in one card
    checkRound(t); // bet-3
    // p0 is all-up and behind; p1 leads — nobody may flip: showdown.
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots[0]).toMatchObject({ amount: 2, winners: ['p1'] });
    expect(result.revealed['p1']).toHaveLength(7);
    expect(t.totalChips()).toBe(40);
  });

  it('folding to a bet ends the hand as a fold win', () => {
    const t = new Table(2, { config: BASEBALL });
    t.start();
    rig7(t, { p1: ['Ah', 'Kc', '6d', 'Jd', '7c', '2h', '4s'], p0: BUST });
    flip(t, 'p1');
    t.act('p1', 'bet', 5);
    t.act('p0', 'fold');
    expect(t.state.phase).toBe('hand-over');
    // Fold win: the whole pot (antes 2 + p1's own uncalled 5) goes back to p1.
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 7, winners: ['p1'] });
    expect(t.totalChips()).toBe(40);
  });
});

describe('all-in interactions', () => {
  it('players all-in during betting still take their flip rounds; betting is skipped', () => {
    const t = new Table(3, { config: { ...BASEBALL, ...REBUY_CONFIG } });
    t.start();
    rig7(t, { p1: P1, p2: P2, p0: P0 });
    flip(t, 'p1');
    t.act('p1', 'bet', 19); // all-in (20 - 1 ante)
    t.act('p2', 'call');
    t.act('p0', 'call');
    expect(t.hand.allIn.sort()).toEqual(['p0', 'p1', 'p2']);
    // Betting closed; p2's flip round still runs while all-in.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p2');
    flip(t, 'p2');
    flip(t, 'p2'); // pair of queens
    // bet-2 has no actors — skipped straight to p0's flip round.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p0');
    flip(t, 'p0');
    flip(t, 'p0'); // pair of aces
    // Betting still skipped; the orbit continues through the trailing
    // players' remaining cards until both bust out — p0 never re-flips.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'flip' });
    expect(t.toAct).toBe('p1');
    for (let i = 0; i < 6; i++) flip(t, 'p1');
    expect(t.hand.folded).toContain('p1');
    expect(t.toAct).toBe('p2');
    for (let i = 0; i < 5; i++) flip(t, 'p2');
    expect(t.hand.folded).toContain('p2');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0]).toMatchObject({ amount: 60, winners: ['p0'] });
    expect(t.stack('p0')).toBe(60);
    expect(t.totalChips()).toBe(60);
  });
});

describe('timeouts', () => {
  it('auto-flips one card per sweep tick until the player busts out', () => {
    const t = new Table(2, { config: BASEBALL });
    t.start();
    rig7(t, { p1: ['Ah', 'Kc', '6d', 'Jd', '7c', '2h', '4s'], p0: BUST });
    flip(t, 'p1');
    checkRound(t);
    expect(t.toAct).toBe('p0');

    // First expiry arms the time bank.
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(t.hand.playerCards['p0'].faceUp.filter(Boolean)).toHaveLength(0);

    // Second expiry auto-flips and marks the player away.
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(t.hand.playerCards['p0'].faceUp.filter(Boolean)).toHaveLength(1);
    expect(t.state.players['p0'].status).toBe('away');
    expect(t.toAct).toBe('p0'); // turn continues on the sweep's clock

    // Away player: each sweep tick flips the next card until they bust.
    let guard = 0;
    while (t.state.phase === 'playing') {
      if (guard++ > 12) throw new Error('timeout sweep did not finish the hand');
      t.now = Math.max(t.now, t.hand.round.actionDeadline ?? t.now) + 1;
      t.apply({ type: 'timeout' });
    }
    expect(t.hand.playerCards['p0'].faceUp).toEqual(Array(7).fill(true));
    expect(t.hand.folded).toContain('p0');
    expect(t.hand.result!.pots[0].winners).toEqual(['p1']);
    const autoFlips = t.state.events.filter(
      (e) => e.type === 'action' && (e.data as { move: string; auto: boolean }).move === 'flip'
        && (e.data as { auto: boolean }).auto
    );
    expect(autoFlips).toHaveLength(7);
    expect(t.totalChips()).toBe(40);
  });
});

describe('no-peek secrecy', () => {
  it('hides your own down cards; flipped cards are public to all', () => {
    const t = riggedTable();
    flip(t, 'p1'); // Kd public
    const mine = redactForPlayer(t.state, 'p1');
    expect(mine.hand!.myCards).toEqual(['Kd']); // own down cards absent
    expect(mine.hand!.cardCounts['p1']).toBe(7);

    const rival = redactForPlayer(t.state, 'p2');
    expect(rival.hand!.publicCards['p1']).toEqual(['Kd']);
    expect(rival.hand!.myCards).toEqual([]); // p2 cannot see their own hand either

    for (const viewer of ['p0', 'p1', 'p2', null]) {
      const json = JSON.stringify(redactForPlayer(t.state, viewer));
      for (const card of P1.slice(1)) expect(json).not.toContain(card); // p1's down cards
      for (const card of P2) expect(json).not.toContain(card); // p2 fully hidden
      for (const card of P0) expect(json).not.toContain(card);
    }
  });

  it('the bot view is equally blind to its own down cards', () => {
    const t = riggedTable();
    const preFlip = buildBotView(t.state, 'p1')!;
    expect(preFlip.hole).toEqual([]); // nothing flipped yet
    expect(baseball.bot.decideExchange!(preFlip, zeroRand)).toEqual({ kind: 'flip' });

    flip(t, 'p1');
    const view = buildBotView(t.state, 'p1')!;
    expect(view.hole).toEqual(['Kd']); // flipped cards only
    const decision = baseball.bot.decideBet(view, zeroRand);
    expect(['check', 'bet', 'raise', 'call', 'fold']).toContain(decision.move);
  });
});

describe('dealer choice integration', () => {
  it('a dealer can call baseball and the whole hand settles cleanly', () => {
    const t = new Table(3, { config: { enabledVariants: ['holdem', 'baseball'] } });
    t.start();
    expect(t.state.phase).toBe('choosing');
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'baseball' });
    expect(t.hand.variant).toBe('baseball');
    rig7(t, { p1: P1, p2: P2, p0: P0 });
    flip(t, 'p1');
    checkRound(t);
    flip(t, 'p2');
    flip(t, 'p2');
    checkRound(t);
    flip(t, 'p0');
    flip(t, 'p0'); // pair of aces leads
    checkRound(t);
    // The orbit runs the trailing hands out of cards; p0 wins as the last
    // player standing.
    for (let i = 0; i < 6; i++) flip(t, 'p1');
    checkRound(t);
    for (let i = 0; i < 5; i++) flip(t, 'p2');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result!.pots[0]).toMatchObject({ winners: ['p0'] });
    expect(t.totalChips()).toBe(60);
  });
});
