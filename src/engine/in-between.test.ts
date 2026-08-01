import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError, seededRandInt } from './test-utils';
import { getLegalActions } from './betting';
import { _registerVariantForTest } from './variants/registry';
import { inBetween } from './variants/in-between';
import type { BotView } from './bot';
import type { TableConfig } from './types';

/**
 * In-between (acey-deucey) scenarios. zeroRand geometry: first-hand button =
 * seat 0 (p0), hand order [p1, p2, p0], p1 takes the first turn. The zeroRand
 * shuffle never puts an ace first for the opening turn, so t.start() always
 * lands on a plain two-card turn for p1 — rig helpers below take over from
 * there.
 */

const IB = { enabledVariants: ['in-between'] as ['in-between'], ante: 2 };

let unregister: () => void;
beforeEach(() => {
  unregister = _registerVariantForTest(inBetween);
});
afterEach(() => {
  unregister();
});

function ibTable(
  players = 3,
  opts: { config?: Partial<TableConfig>; stacks?: number[]; rand?: (n: number) => number } = {}
): Table {
  const t = new Table(players, {
    config: { ...IB, ...opts.config },
    stacks: opts.stacks,
    rand: opts.rand,
  });
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

/** Current player passes (calling an ace high first if one is showing). */
function passTurn(t: Table): void {
  const id = t.toAct!;
  const legal = getLegalActions(t.state, id)!;
  if (legal.kind === 'exchange' && legal.moves[0].kind === 'aceCall') {
    t.apply({ type: 'variantMove', playerId: id, move: { kind: 'aceCall', high: true } });
  }
  t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
}

interface ResultData {
  playerId: string;
  cards: [string, string];
  third: string;
  outcome: 'win' | 'lose' | 'post' | 'pass';
  amount: number;
  potAfter: number;
}

function lastResult(t: Table): ResultData {
  const ev = t.state.events.filter((e) => e.type === 'in-between-result').at(-1);
  if (!ev) throw new Error('no in-between-result event');
  return ev.data as ResultData;
}

describe('dealing and setup', () => {
  it('antes into the communal pot, empty player cards, two up-cards for the first player', () => {
    const t = ibTable();
    expect(t.hand.variant).toBe('in-between');
    expect(t.hand.pot).toBe(6);
    expect(t.hand.totalCommitted).toEqual({});
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'in-between' });
    expect(t.toAct).toBe('p1');
    expect(t.hand.board).toHaveLength(2);
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id]).toEqual({ cards: [], faceUp: [] });
    }
    const turn = t.state.events.filter((e) => e.type === 'in-between-turn').at(-1)!;
    expect(turn.data).toMatchObject({ playerId: 'p1' });
    expect((turn.data as { cards: string[] }).cards).toEqual(t.hand.board);
    expect(t.totalChips()).toBe(60);
  });

  it('legal spec: wager 0..min(pot, stack), auto-move is a pass', () => {
    const t = ibTable();
    expect(getLegalActions(t.state, 'p1')).toEqual({
      kind: 'exchange',
      moves: [{ kind: 'wager', min: 0, max: 6 }],
      autoMove: { kind: 'wager', amount: 0 },
    });
  });

  it('legal max is capped by a short stack', () => {
    const t = ibTable(3, { stacks: [40, 4, 40] });
    // p1 has 4 - 2 ante = 2 behind; pot is 6.
    const legal = getLegalActions(t.state, 'p1')!;
    expect(legal).toMatchObject({ moves: [{ kind: 'wager', min: 0, max: 2 }] });
  });
});

describe('outcomes and chip movement', () => {
  it('third card strictly between wins the wager from the pot', () => {
    const t = ibTable();
    rigTurn(t, ['2s', 'Ks'], '8h');
    wager(t, 'p1', 4);
    expect(t.stack('p1')).toBe(22); // 20 - 2 ante + 4
    expect(t.hand.pot).toBe(2);
    expect(lastResult(t)).toEqual({
      playerId: 'p1',
      cards: ['2s', 'Ks'],
      third: '8h',
      outcome: 'win',
      amount: 4,
      potAfter: 2,
    });
    // The retired cards went to discards and the next turn was dealt.
    expect(t.hand.discards).toEqual(expect.arrayContaining(['2s', 'Ks', '8h']));
    expect(t.toAct).toBe('p2');
    expect(t.hand.board.length).toBeGreaterThanOrEqual(1);
    expect(t.totalChips()).toBe(60);
  });

  it('third card outside pays the wager into the pot', () => {
    const t = ibTable();
    rigTurn(t, ['5s', '9s'], '2h');
    wager(t, 'p1', 3);
    expect(t.stack('p1')).toBe(15); // 18 - 3
    expect(t.hand.pot).toBe(9);
    expect(lastResult(t)).toMatchObject({ outcome: 'lose', amount: 3, potAfter: 9 });
    expect(t.totalChips()).toBe(60);
  });

  it('hitting the post pays double', () => {
    const t = ibTable();
    rigTurn(t, ['5s', '9s'], '9h');
    wager(t, 'p1', 3);
    expect(t.stack('p1')).toBe(12); // 18 - 6
    expect(t.hand.pot).toBe(12);
    expect(lastResult(t)).toMatchObject({ outcome: 'post', amount: 6 });
    expect(t.totalChips()).toBe(60);
  });

  it('the double post is capped at the stack (table stakes) and marks all-in', () => {
    const t = ibTable(3, { stacks: [40, 6, 40] });
    // p1: 6 - 2 ante = 4 behind; pot 6; max wager min(6, 4) = 4.
    rigTurn(t, ['5s', '9s'], '9h');
    wager(t, 'p1', 4); // owes 8, pays only 4
    expect(t.stack('p1')).toBe(0);
    expect(t.hand.pot).toBe(10);
    expect(t.hand.allIn).toContain('p1');
    expect(lastResult(t)).toMatchObject({ outcome: 'post', amount: 4, potAfter: 10 });
    expect(t.totalChips()).toBe(86);
    // Broke p1 sits out from here — orbits run over the solvent players only.
    passTurn(t); // p2
    passTurn(t); // p0 -> orbit 2 opens (p1 wagered this orbit)
    expect(t.state.phase).toBe('playing');
    expect(t.toAct).toBe('p2'); // straight past p1
    expect(getLegalActions(t.state, 'p1')).toBeNull();
    passTurn(t); // p2
    passTurn(t); // p0 -> all-pass orbit ends the hand
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(10);
    expect(t.state.players['p1'].status).toBe('busted');
    expect(t.totalChips()).toBe(86);
  });

  it('a pass burns no card: it becomes the next player\'s first up-card', () => {
    const t = ibTable();
    rigTurn(t, ['2s', 'Ks'], '8h'); // '8h' rigged as the NEXT deck card
    t.hand.deck[t.hand.deckPos + 1] = '4c';
    wager(t, 'p1', 0);
    expect(t.stack('p1')).toBe(18);
    expect(t.hand.pot).toBe(6);
    expect(lastResult(t)).toMatchObject({ outcome: 'pass', amount: 0, third: null });
    expect(t.toAct).toBe('p2');
    // The would-be third card was never drawn — it opens p2's turn instead.
    expect(t.hand.board).toEqual(['8h', '4c']);
    // Only the passer's two up-cards retired.
    expect(t.hand.discards).toEqual(['2s', 'Ks']);
    expect(t.totalChips()).toBe(60);
  });

  it('consecutive cards: passing is legal, wagering anyway just loses', () => {
    const t = ibTable();
    rigTurn(t, ['5s', '6s'], '9h');
    expect(getLegalActions(t.state, 'p1')).toMatchObject({
      moves: [{ kind: 'wager', min: 0, max: 6 }], // max still > 0 — their choice
    });
    wager(t, 'p1', 2); // nothing fits between 5 and 6
    expect(lastResult(t)).toMatchObject({ outcome: 'lose', amount: 2 });
    expect(t.totalChips()).toBe(60);
  });

  it('winning the whole pot ends the hand immediately', () => {
    const t = ibTable();
    rigTurn(t, ['2s', 'Ks'], '8h');
    wager(t, 'p1', 6);
    expect(t.hand.pot).toBe(0);
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.hand.result!.pots).toEqual([]);
    expect(t.state.carryPot).toBe(0);
    expect(t.stack('p1')).toBe(24);
    expect(t.totalChips()).toBe(60);
  });
});

describe('wager validation', () => {
  it('rejects negative, fractional, and oversized wagers', () => {
    const t = ibTable();
    rigTurn(t, ['2s', 'Ks'], '8h');
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: -1 } }),
      'bad-amount'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 2.5 } }),
      'bad-amount'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 7 } }),
      'bad-amount' // pot is only 6
    );
    expect(t.totalChips()).toBe(60);
  });

  it('rejects out-of-turn wagers and foreign move kinds', () => {
    const t = ibTable();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'wager', amount: 0 } }),
      'not-your-turn'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } }),
      'illegal-move'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: true } }),
      'illegal-move' // no ace showing
    );
  });
});

describe('ace call', () => {
  it('a first-card ace pauses the deal for the high/low call, then the wager', () => {
    const t = ibTable();
    expect(t.hand.board).toHaveLength(2); // p1's natural (non-ace) opening turn
    rigDeck(t, ['Ah', '9h', 'Kd']); // p1 passes (burns nothing), then p2's turn
    wager(t, 'p1', 0);
    expect(t.toAct).toBe('p2');
    expect(t.hand.board).toEqual(['Ah']); // only one card dealt so far
    expect(getLegalActions(t.state, 'p2')).toEqual({
      kind: 'exchange',
      moves: [{ kind: 'aceCall' }],
      autoMove: { kind: 'aceCall', high: false },
    });
    const aceEv = t.state.events.filter((e) => e.type === 'in-between-ace').at(-1)!;
    expect(aceEv.data).toEqual({ playerId: 'p2', card: 'Ah' });
    // Cannot wager before calling the ace.
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'wager', amount: 2 } }),
      'illegal-move'
    );
    // Call it high: second card dealt, same player keeps the turn.
    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'aceCall', high: true } });
    expect(t.toAct).toBe('p2');
    expect(t.hand.round.actionDeadline).not.toBeNull(); // fresh clock
    expect(t.hand.board).toEqual(['Ah', '9h']);
    const turnEv = t.state.events.filter((e) => e.type === 'in-between-turn').at(-1)!;
    expect(turnEv.data).toEqual({ playerId: 'p2', cards: ['Ah', '9h'], aceLow: false });
    // Ace high: window is 9..14, K (13) wins.
    wager(t, 'p2', 3);
    expect(lastResult(t)).toMatchObject({ playerId: 'p2', outcome: 'win', amount: 3, third: 'Kd' });
    expect(t.stack('p2')).toBe(21);
    expect(t.hand.pot).toBe(3);
    expect(t.totalChips()).toBe(60);
  });

  it('an ace called low counts as 1: low third card wins', () => {
    const t = ibTable();
    rigAceTurn(t, '9h', '5c');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: false } });
    expect(t.hand.board).toEqual(['Ah', '9h']);
    wager(t, 'p1', 2); // window 1..9, 5 is inside
    expect(lastResult(t)).toMatchObject({ outcome: 'win', amount: 2 });
    expect(t.stack('p1')).toBe(20);
    expect(t.totalChips()).toBe(60);
  });

  it('an ace called low loses to a high third card', () => {
    const t = ibTable();
    rigAceTurn(t, '9h', 'Kd');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: false } });
    wager(t, 'p1', 2); // window 1..9, K is outside
    expect(lastResult(t)).toMatchObject({ outcome: 'lose', amount: 2 });
    expect(t.stack('p1')).toBe(16);
    expect(t.totalChips()).toBe(60);
  });

  it('a third-card ace hits the post of a low-called ace (rank match, double)', () => {
    const t = ibTable();
    rigAceTurn(t, '9h', 'Ad');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'aceCall', high: false } });
    wager(t, 'p1', 2);
    expect(lastResult(t)).toMatchObject({ outcome: 'post', amount: 4 });
    expect(t.stack('p1')).toBe(14); // 18 - 4
    expect(t.hand.pot).toBe(10);
    expect(t.totalChips()).toBe(60);
  });
});

describe('orbits, hand end, and carry', () => {
  it('a full orbit of passes ends the hand; the pot carries and seeds the next hand', () => {
    const t = ibTable();
    passTurn(t);
    passTurn(t);
    passTurn(t);
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(6);
    expect(t.totalChips()).toBe(60);
    t.nextHand();
    expect(t.hand.variant).toBe('in-between');
    expect(t.hand.pot).toBe(12); // carried 6 + fresh antes 6
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('a wager keeps the hand alive into another orbit, opened by the first player', () => {
    const t = ibTable();
    expect(t.toAct).toBe('p1');
    rigTurn(t, ['5s', '9s'], '2h');
    wager(t, 'p1', 2); // lose -> pot 8, anyWagered
    passTurn(t); // p2
    passTurn(t); // p0 — orbit closes, but a wager happened
    expect(t.state.phase).toBe('playing');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'in-between' });
    expect(t.hand.round.actedSinceFullRaise).toEqual([]); // fresh round
    expect(t.toAct).toBe('p1');
    const dealt = t.state.events
      .filter((e) => e.type === 'in-between-turn' || e.type === 'in-between-ace')
      .at(-1)!;
    expect(dealt.data).toMatchObject({ playerId: 'p1' }); // orbit 2 dealt for p1
    expect(t.hand.pot).toBe(8);
    // Orbit 2: everyone passes -> hand over, remaining pot carries.
    passTurn(t);
    passTurn(t);
    passTurn(t);
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(8);
    expect(t.totalChips()).toBe(60);
  });
});

describe('deck reshuffle', () => {
  it('rebuilds the deck when fewer than 3 cards remain before a turn', () => {
    const t = ibTable();
    t.hand.deckPos = 50; // 2 cards left; the current turn is already dealt
    wager(t, t.toAct!, 0); // third from deck[50], then the next turn forces a reshuffle
    expect(t.state.events.some((e) => e.type === 'in-between-reshuffle')).toBe(true);
    expect(t.hand.deck).toHaveLength(52);
    expect(t.hand.deckPos).toBeLessThanOrEqual(2);
    expect(t.hand.discards).toEqual([]); // retired cards are back in the deck
    expect(t.hand.board.length).toBeGreaterThanOrEqual(1);
    expect(t.state.phase).toBe('playing');
    expect(t.totalChips()).toBe(60);
    // Play continues normally on the fresh deck.
    passTurn(t);
    passTurn(t);
    expect(t.state.phase).toBe('hand-over'); // all-pass orbit
    expect(t.state.carryPot).toBe(6);
    expect(t.totalChips()).toBe(60);
  });
});

describe('timeouts', () => {
  it('timeout auto-passes and marks the player away', () => {
    const t = ibTable(3, { config: { timeBankMs: 0 } });
    const first = t.toAct!;
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(lastResult(t)).toMatchObject({ playerId: first, outcome: 'pass', amount: 0 });
    expect(t.state.players[first].status).toBe('away');
    expect(t.toAct).not.toBe(first);
    expect(t.hand.pot).toBe(6);
    expect(t.totalChips()).toBe(60);
  });

  it('timeout on a first-card ace auto-calls low, then the sweep auto-passes', () => {
    const t = ibTable(3, { config: { timeBankMs: 0 } });
    rigAceTurn(t, '9h', 'Kd');
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // auto aceCall low, turn continues
    expect(t.toAct).toBe('p1');
    expect(t.hand.board).toEqual(['Ah', '9h']);
    expect(t.state.players['p1'].status).toBe('away');
    t.apply({ type: 'timeout' }); // away player: instant deadline, auto-pass
    expect(lastResult(t)).toMatchObject({ playerId: 'p1', outcome: 'pass', amount: 0 });
    expect(t.toAct).toBe('p2');
    expect(t.totalChips()).toBe(60);
  });
});

describe('bot policy', () => {
  const decide = inBetween.bot.decideExchange!;

  function view(partial: Partial<BotView> = {}): BotView {
    return {
      hole: [],
      board: [],
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

  it('wagers on a wide spread, within the legal max, deterministically', () => {
    const v = view({ board: ['2s', 'Ks'] }); // spread 10
    const a = decide(v, seededRandInt(1));
    const b = decide(v, seededRandInt(1));
    expect(a).toEqual(b);
    expect(a.kind).toBe('wager');
    if (a.kind !== 'wager') throw new Error('unreachable');
    expect(a.amount).toBeGreaterThan(0);
    expect(a.amount).toBeLessThanOrEqual(12);
  });

  it('passes on narrow, consecutive, and paired boards', () => {
    for (const board of [
      ['5s', '9s'], // spread 3
      ['5s', '6s'], // consecutive
      ['9s', '9h'], // paired
    ]) {
      expect(decide(view({ board }), seededRandInt(1))).toEqual({ kind: 'wager', amount: 0 });
    }
  });

  it('passes when the legal max is 0 (empty pot share or busted stack)', () => {
    const v = view({
      board: ['2s', 'Ks'],
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'wager', min: 0, max: 0 }],
        autoMove: { kind: 'wager', amount: 0 },
      },
    });
    expect(decide(v, seededRandInt(1))).toEqual({ kind: 'wager', amount: 0 });
  });

  it('aggression shapes the wager upward', () => {
    const timid = decide(
      view({ board: ['2s', 'Ks'], personality: { tightness: 0.5, aggression: 0, bluffFreq: 0 } }),
      seededRandInt(1)
    );
    const wild = decide(
      view({ board: ['2s', 'Ks'], personality: { tightness: 0.5, aggression: 1, bluffFreq: 0 } }),
      seededRandInt(1)
    );
    if (timid.kind !== 'wager' || wild.kind !== 'wager') throw new Error('unreachable');
    expect(wild.amount).toBeGreaterThanOrEqual(timid.amount);
  });

  it('answers an ace call with a high/low pick', () => {
    const v = view({
      board: ['Ah'],
      legal: {
        kind: 'exchange',
        moves: [{ kind: 'aceCall' }],
        autoMove: { kind: 'aceCall', high: false },
      },
    });
    const move = decide(v, seededRandInt(3));
    expect(move.kind).toBe('aceCall');
    if (move.kind !== 'aceCall') throw new Error('unreachable');
    expect(typeof move.high).toBe('boolean');
    expect(decide(v, seededRandInt(3))).toEqual(move); // deterministic given randInt
  });

  it('decideBet is an inert stub (no betting rounds exist)', () => {
    expect(inBetween.bot.decideBet(view(), seededRandInt(1))).toEqual({ move: 'check' });
  });
});

describe('soak: random play', () => {
  it('conserves chips at every step across several hands and always terminates', () => {
    const t = new Table(4, { config: { ...IB }, rand: seededRandInt(42) });
    t.start();
    const rand = seededRandInt(7);
    let guard = 0;
    for (let handNo = 0; handNo < 3 && t.state.phase !== 'ended'; handNo++) {
      let wagerSteps = 0;
      while (t.state.phase === 'playing') {
        if (++guard > 2000) throw new Error('soak did not terminate');
        const id = t.toAct!;
        const legal = getLegalActions(t.state, id)!;
        if (legal.kind !== 'exchange') throw new Error('expected exchange round');
        const spec = legal.moves[0];
        if (spec.kind === 'aceCall') {
          t.apply({
            type: 'variantMove',
            playerId: id,
            move: { kind: 'aceCall', high: rand(2) === 1 },
          });
        } else if (spec.kind === 'wager') {
          // Modest random wagers for a while, then pass out to end the hand.
          const amount = wagerSteps < 25 ? rand(Math.min(spec.max, 3) + 1) : 0;
          wagerSteps++;
          t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount } });
        } else {
          throw new Error(`unexpected move spec ${spec.kind}`);
        }
        expect(t.totalChips()).toBe(80);
      }
      // Busts can legitimately end the game between hands; chips stay conserved.
      expect(['hand-over', 'ended']).toContain(t.state.phase);
      expect(t.totalChips()).toBe(80);
      if (t.state.phase === 'hand-over') {
        t.nextHand();
        expect(t.totalChips()).toBe(80);
      }
    }
  });
});
