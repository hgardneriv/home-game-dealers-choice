import { describe, expect, it } from 'vitest';
import { Table, seededRandInt } from './test-utils';
import { chooseDiscards, fiveDraw } from './variants/five-draw';
import { inBetween } from './variants/in-between';
import { newDeck } from './deck';
import type { BotView } from './bot';
import type { EngineResult, HandState, TableConfig } from './types';
import type { VariantCtx } from './variants/types';

/**
 * Mutation-hardening tests for five-draw and in-between. Each test pins a
 * RULES behavior a baseline Stryker survivor showed to be unasserted:
 * validation error identities, event payloads, deck/reshuffle accounting,
 * phase cursors, next-player computation, and structural bot-move wiring.
 * Bot tuning constants (strength maps, wager sizing) are deliberately not
 * pinned here.
 */

const DRAW = { enabledVariants: ['five-draw'] as ['five-draw'] };
const IB = { enabledVariants: ['in-between'] as ['in-between'], ante: 2 };

function expectErrorMsg(res: EngineResult, code: string, message: string): void {
  if (res.ok) throw new Error(`expected error ${code}, got success`);
  expect(res.error.code).toBe(code);
  expect(res.error.message).toBe(message);
}

function lastEvent(t: Table, type: string) {
  const ev = t.state.events.filter((e) => e.type === type).at(-1);
  if (!ev) throw new Error(`no ${type} event`);
  return ev;
}

// ---------------------------------------------------------------------------
// Five-card draw
// ---------------------------------------------------------------------------

function drawTable(players = 3): Table {
  const t = new Table(players, { config: DRAW });
  t.start();
  return t;
}

/** Check the first round down so p1 is on the draw. */
function atDraw(): Table {
  const t = drawTable();
  t.act('p1', 'check');
  t.act('p2', 'check');
  t.act('p0', 'check');
  return t;
}

describe('five-draw: table fit bounds', () => {
  it('fits exactly 2..6 players', () => {
    expect(fiveDraw.fitsPlayers(1)).toBe(false);
    expect(fiveDraw.fitsPlayers(2)).toBe(true);
    expect(fiveDraw.fitsPlayers(6)).toBe(true);
    expect(fiveDraw.fitsPlayers(7)).toBe(false);
  });
});

describe('five-draw: chooseDiscards structural rules', () => {
  it('finds a pair that is not first in dealt order (rank grouping is sorted)', () => {
    expect(chooseDiscards(['9d', '4s', '4h', '7c', 'Ks']).sort()).toEqual([0, 3, 4]);
  });

  it('finds two pair behind a leading odd card', () => {
    expect(chooseDiscards(['7s', '9s', '9h', '4d', '4c'])).toEqual([0]);
  });

  it('detects an open-ended straight draw from unsorted cards', () => {
    expect(chooseDiscards(['8c', '5s', '6h', '7d', 'Kd'])).toEqual([4]);
  });

  it('detects a four-flush in every suit', () => {
    expect(chooseDiscards(['2s', '7s', '9s', 'Js', 'Kd'])).toEqual([4]);
    expect(chooseDiscards(['2h', '7h', '9h', 'Jh', 'Kd'])).toEqual([4]);
    expect(chooseDiscards(['2d', '7d', '9d', 'Jd', 'Ks'])).toEqual([4]);
    expect(chooseDiscards(['2c', '7c', '9c', 'Jc', 'Kd'])).toEqual([4]);
  });
});

describe('five-draw: discard validation identities', () => {
  it('names each rejection precisely', () => {
    const t = atDraw();
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 0 } }),
      'illegal-move',
      'Expected a discard'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [1, 1] } }),
      'bad-amount',
      'Duplicate cards'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1, 2, 3] } }),
      'bad-amount',
      'Discard at most 3'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [-1] } }),
      'bad-amount',
      'No such card'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0.5] } }),
      'bad-amount',
      'No such card'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [5] } }),
      'bad-amount',
      'No such card'
    );
  });
});

describe('five-draw: draw mechanics', () => {
  it('retires the exact thrown cards, appends replacements in order, resets faceUp', () => {
    const t = atDraw();
    t.hand.playerCards['p1'].cards = ['2s', '5h', '9d', 'Jc', 'Kd'];
    t.hand.deck[t.hand.deckPos] = 'As';
    t.hand.deck[t.hand.deckPos + 1] = 'Qh';
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 4] } });
    expect(t.hand.discards).toEqual(['2s', 'Kd']);
    expect(t.hand.playerCards['p1'].cards).toEqual(['5h', '9d', 'Jc', 'As', 'Qh']);
    expect(t.hand.playerCards['p1'].faceUp).toEqual([false, false, false, false, false]);
    expect(lastEvent(t, 'action').data).toEqual({
      playerId: 'p1',
      move: 'draw',
      detail: { count: 2 },
      street: 'draw',
      auto: false,
    });
  });

  it('a zero-card discard is reported as standing pat', () => {
    const t = atDraw();
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } });
    expect(lastEvent(t, 'action').data).toEqual({
      playerId: 'p1',
      move: 'stand pat',
      detail: { count: 0 },
      street: 'draw',
      auto: false,
    });
  });
});

describe('five-draw: bot wiring (not tuning)', () => {
  function view(partial: Partial<BotView> = {}): BotView {
    return {
      hole: ['2s', '5h', '9d', 'Jc', 'Kd'],
      board: [],
      publicCards: {},
      potTotal: 6,
      stack: 20,
      committed: 0,
      legal: {
        kind: 'betting',
        canFold: true,
        canCheck: true,
        callAmount: 0,
        canBet: true,
        canRaise: false,
        minRaiseTo: 2,
        maxRaiseTo: 22,
      },
      activeCount: 3,
      personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1 },
      minBet: 2,
      ...partial,
    };
  }

  it('decideBet returns a concrete betting decision', () => {
    const d = fiveDraw.bot.decideBet(view(), seededRandInt(1));
    expect(d).toBeTruthy();
    expect(typeof d.move).toBe('string');
  });

  it('decideExchange proposes exactly the chooseDiscards picks', () => {
    const move = fiveDraw.bot.decideExchange!(view(), seededRandInt(1));
    expect(move).toEqual({ kind: 'discard', cardIndexes: [0, 1, 2] });
  });
});

// ---------------------------------------------------------------------------
// In-between
// ---------------------------------------------------------------------------

function ibTable(
  players = 3,
  opts: { config?: Partial<TableConfig>; stacks?: number[] } = {}
): Table {
  const t = new Table(players, { config: { ...IB, ...opts.config }, stacks: opts.stacks });
  t.start();
  return t;
}

/** Rig the CURRENT turn: overwrite the two up-cards and the third card to come. */
function rigTurn(t: Table, up: [string, string], third: string): void {
  const hand = t.hand;
  hand.board = [...up];
  hand.vstate.awaitingAce = false;
  hand.vstate.aceLow = false;
  hand.deck[hand.deckPos] = third;
}

/** Rig the CURRENT turn as a first-card ace awaiting the high/low call. */
function rigAceTurn(t: Table, second: string, third: string): void {
  const hand = t.hand;
  hand.board = ['Ah'];
  hand.vstate.awaitingAce = true;
  hand.vstate.aceLow = false;
  hand.deck[hand.deckPos] = second;
  hand.deck[hand.deckPos + 1] = third;
}

/** Overwrite upcoming deck cards starting at deckPos (before they are dealt). */
function rigDeck(t: Table, cards: string[]): void {
  cards.forEach((c, i) => {
    t.hand.deck[t.hand.deckPos + i] = c;
  });
}

function wager(t: Table, playerId: string, amount: number) {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'wager', amount } });
}

interface ResultData {
  playerId: string;
  outcome: 'win' | 'lose' | 'post' | 'pass';
  amount: number;
}

function lastResult(t: Table): ResultData {
  return lastEvent(t, 'in-between-result').data as ResultData;
}

/** Bare VariantCtx over a hand-shaped object, for direct phase-cursor calls. */
function fakeCtx(handOverrides: Partial<HandState> = {}): VariantCtx {
  const hand = {
    inHand: ['a'],
    folded: ['a'],
    board: [],
    discards: [],
    deck: newDeck(),
    deckPos: 0,
    playerCards: {},
    vstate: {},
    pot: 5,
    allIn: [],
    round: { kind: 'exchange', street: 'in-between', toAct: null, actedSinceFullRaise: [] },
    ...handOverrides,
  } as unknown as HandState;
  return {
    state: { players: {} },
    hand,
    config: {},
    randInt: seededRandInt(1),
    draw: () => hand.deck[hand.deckPos++],
    emit: () => {},
  } as unknown as VariantCtx;
}

describe('in-between: table fit bounds', () => {
  it('fits exactly 2..6 players', () => {
    expect(inBetween.fitsPlayers(1)).toBe(false);
    expect(inBetween.fitsPlayers(2)).toBe(true);
    expect(inBetween.fitsPlayers(6)).toBe(true);
    expect(inBetween.fitsPlayers(7)).toBe(false);
  });
});

describe('in-between: phase cursors with no active player', () => {
  it('deal ends in showdown when nobody can take a turn', () => {
    expect(inBetween.deal(fakeCtx())).toEqual({ kind: 'showdown' });
  });

  it('nextPhase ends in showdown when nobody can take a turn', () => {
    expect(inBetween.nextPhase(fakeCtx({ vstate: { anyWagered: true } }))).toEqual({
      kind: 'showdown',
    });
  });
});

describe('in-between: inert showdown surface', () => {
  it('score is always 0 and describeScore is empty', () => {
    expect(inBetween.score({} as HandState, 'p1')).toBe(0);
    expect(inBetween.describeScore(123)).toBe('');
  });

  it('resolve returns the exact empty result', () => {
    expect(inBetween.resolve!({} as HandState)).toEqual({
      result: { pots: [], revealed: {}, descriptions: {}, showdownOrder: [], refunds: {} },
      payouts: {},
    });
  });
});

describe('in-between: deck accounting', () => {
  it('exactly 3 cards remaining is enough for a turn — no reshuffle', () => {
    const t = ibTable();
    // A pass burns nothing, so park exactly 3 cards before the next deal.
    t.hand.deckPos = 49;
    rigDeck(t, ['7h', '9c', '5d']); // next turn's two up-cards (+ its third)
    wager(t, t.toAct!, 0);
    expect(t.state.events.some((e) => e.type === 'in-between-reshuffle')).toBe(false);
    expect(t.hand.deck).toHaveLength(52);
    expect(t.hand.deckPos).toBe(51);
    expect(t.hand.board).toEqual(['7h', '9c']);
  });

  it('a fresh turn clears any stale low-ace call (deal path, not rigging)', () => {
    const t = ibTable();
    rigDeck(t, ['Kh', '9h', '5c']); // p1 passes; p2 gets Kh 9h with third 5c
    wager(t, 'p1', 0);
    expect(t.hand.board).toEqual(['Kh', '9h']);
    wager(t, 'p2', 2); // window 9..13 — a 5 is outside
    expect(lastResult(t)).toMatchObject({ playerId: 'p2', outcome: 'lose', amount: 2 });
  });
});

describe('in-between: wager validation identities', () => {
  it('names each rejection precisely', () => {
    const t = ibTable();
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: true } }),
      'illegal-move',
      'No ace to call'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } }),
      'illegal-move',
      'Expected a wager'
    );
    rigTurn(t, ['2s', 'Ks'], '8h'); // pot is 6
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: -1 } }),
      'bad-amount',
      'Wager must be a whole number of chips'
    );
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 7 } }),
      'bad-amount',
      'Wager at most 6'
    );
  });

  it('a pending ace call blocks the wager by name', () => {
    const t = ibTable();
    rigAceTurn(t, '9h', 'Kd');
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 2 } }),
      'illegal-move',
      'Call the ace high or low first'
    );
  });

  it('an incomplete board rejects wagers outright', () => {
    const t = ibTable();
    t.hand.board = ['5s'];
    t.hand.vstate.awaitingAce = false;
    expectErrorMsg(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 0 } }),
      'illegal-move',
      'No cards to bet on'
    );
  });
});

describe('in-between: turn resolution bookkeeping', () => {
  it('a losing wager with chips behind never marks all-in', () => {
    const t = ibTable();
    rigTurn(t, ['5s', '9s'], '2h');
    wager(t, 'p1', 2);
    expect(t.stack('p1')).toBe(16);
    expect(t.hand.allIn).toEqual([]);
  });

  it('the board is cleared when winning the pot ends the hand', () => {
    const t = ibTable();
    rigTurn(t, ['2s', 'Ks'], '8h');
    wager(t, 'p1', 6);
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.board).toEqual([]);
  });

  it('the action event carries the wager outcome payload', () => {
    const t = ibTable();
    rigTurn(t, ['5s', '9s'], '2h');
    wager(t, 'p1', 2);
    expect(lastEvent(t, 'action').data).toEqual({
      playerId: 'p1',
      move: 'wager',
      detail: { amount: 2, outcome: 'lose', third: '2h' },
      street: 'in-between',
      auto: false,
    });
    rigTurn(t, ['2s', 'Ks'], '8h'); // now p2's turn; '8h' stays in the deck
    wager(t, 'p2', 0);
    expect(lastEvent(t, 'action').data).toEqual({
      playerId: 'p2',
      move: 'pass',
      detail: { amount: 0, outcome: 'pass', third: null },
      street: 'in-between',
      auto: false,
    });
  });

  it('the action event carries the ace call payload and keeps the turn', () => {
    const t = ibTable();
    rigAceTurn(t, '9h', 'Kd');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: true } });
    expect(lastEvent(t, 'action').data).toEqual({
      playerId: 'p1',
      move: 'ace-call',
      detail: { high: true },
      street: 'in-between',
      auto: false,
    });
    expect(t.toAct).toBe('p1');
  });

  it('the next turn skips a player who left mid-hand', () => {
    const t = ibTable(4); // hand order [p1, p2, p3, p0], pot 8
    t.apply({ type: 'leave', playerId: 'p2' });
    rigTurn(t, ['2s', 'Ks'], '8h');
    rigDeck(t, ['8h', '6c', 'Td']); // p1's third, then p3's two up-cards
    wager(t, 'p1', 1); // win 1 — pot 7 keeps the hand alive
    expect(lastEvent(t, 'in-between-turn').data).toMatchObject({
      playerId: 'p3',
      cards: ['6c', 'Td'],
    });
    expect(t.toAct).toBe('p3');
  });
});

describe('in-between: bot move wiring (not tuning)', () => {
  const decide = inBetween.bot.decideExchange!;

  function view(partial: Partial<BotView> = {}): BotView {
    return {
      hole: [],
      board: ['2s', 'Ks'],
      publicCards: {},
      potTotal: 0,
      stack: 20,
      committed: 0,
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'wager', min: 0, max: 12 }],
        autoMove: { kind: 'wager', amount: 0 },
      },
      activeCount: 3,
      personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1 },
      minBet: 2,
      ...partial,
    };
  }

  it('passes when handed a non-exchange legal spec', () => {
    const v = view({
      legal: {
        kind: 'betting',
        canFold: true,
        canCheck: true,
        callAmount: 0,
        canBet: false,
        canRaise: false,
        minRaiseTo: 0,
        maxRaiseTo: 0,
      },
    });
    expect(decide(v, seededRandInt(1))).toEqual({ kind: 'wager', amount: 0 });
  });

  it('passes when the board is incomplete', () => {
    expect(decide(view({ board: [] }), seededRandInt(1))).toEqual({ kind: 'wager', amount: 0 });
  });

  it('passes when handed a foreign move spec', () => {
    const v = view({
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'discard', min: 0, max: 3 }],
        autoMove: { kind: 'discard', cardIndexes: [] },
      },
    });
    expect(decide(v, seededRandInt(1))).toEqual({ kind: 'wager', amount: 0 });
  });

  it('the ace call follows the coin flip', () => {
    const v = view({
      board: ['Ah'],
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'aceCall' }],
        autoMove: { kind: 'aceCall', high: false },
      },
    });
    expect(decide(v, () => 1)).toEqual({ kind: 'aceCall', high: true });
    expect(decide(v, () => 0)).toEqual({ kind: 'aceCall', high: false });
  });
});
