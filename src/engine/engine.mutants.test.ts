import { afterEach, describe, expect, it } from 'vitest';
import { Table, expectError, NOW } from './test-utils';
import { defaultVariant, normalizeConfig } from './engine';
import { _registerVariantForTest } from './variants/registry';
import type { GameVariant } from './variants/types';
import type { EngineResult, GameEvent, GameState, TableConfig } from './types';

/**
 * Second-wave mutation-hardening suite for src/engine/engine.ts, written
 * against the surviving mutants of the July 2026 Stryker baseline. Pins:
 * exact error codes AND messages, event names/payloads, boundary comparisons,
 * choosing-phase deadlines and botChooseAt, communal-pot (hand.pot) award
 * remainders, carry disbursement order, timeout/time-bank boundaries,
 * removePlayer paths, and settleOrHold hold-vs-end decisions.
 *
 * Some pins deliberately construct states the engine would not produce on its
 * own (an away flag flipped by hand, a cleared deadline) — those exist to pin
 * guard clauses whose protection is otherwise unobservable.
 */

const data = (e: GameEvent) => e.data as Record<string, unknown>;
const types = (evs: GameEvent[]) => evs.map((e) => e.type);
const eventsOf = (state: GameState, type: string) =>
  state.events.filter((e) => e.type === type);

function okEvents(res: EngineResult): GameEvent[] {
  if (!res.ok) throw new Error(`unexpected error ${res.error.code}: ${res.error.message}`);
  return res.events;
}

/** Pin an engine error's code AND its human-readable message. */
function expectFail(res: EngineResult, code: string, message: string): void {
  if (res.ok) throw new Error(`expected error ${code}, got success`);
  expect(res.error.code).toBe(code);
  expect(res.error.message).toBe(message);
}

// ---------------------------------------------------------------------------
// Stub variants (registered per test, restored after each).
// ---------------------------------------------------------------------------

let cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
});
function register(v: GameVariant): void {
  cleanups.push(_registerVariantForTest(v));
}

/** Communal-pot game: everyone antes into hand.pot; one wager orbit; custom resolve. */
const grab: GameVariant = {
  id: 'in-between',
  name: 'Grab',
  marquee: 'GRAB',
  layoutHint: 'board',
  minPlayers: 2,
  fitsPlayers: (n) => n >= 2 && n <= 6,
  potStyle: 'communal',
  deal(v) {
    for (const id of v.hand.inHand) v.hand.playerCards[id] = { cards: [], faceUp: [] };
    return { kind: 'exchange', street: 'grab' };
  },
  nextPhase: () => ({ kind: 'showdown' }),
  score: () => 0,
  describeScore: () => '',
  resolve: () => ({
    result: {
      pots: [],
      revealed: {},
      descriptions: { note: 'custom-resolve' },
      showdownOrder: [],
      refunds: {},
    },
    payouts: {},
  }),
  exchange: {
    legal: () => ({
      kind: 'exchange',
      moves: [{ kind: 'wager', min: 0, max: 999 }],
      autoMove: { kind: 'wager', amount: 0 },
    }),
    apply(v, playerId, move) {
      if (move.kind !== 'wager')
        return { error: { code: 'illegal-move', message: 'wager only' } };
      const win = Math.min(move.amount, v.hand.pot);
      v.hand.pot -= win;
      v.state.players[playerId].stack += win;
      return { applied: { move: 'grab', detail: { win } } };
    },
  },
  bot: { decideBet: () => ({ move: 'check' }) },
};

/** Committed-ante betting game where first-in-hand-order always wins. */
function drainBase(): Omit<GameVariant, 'settle'> {
  return {
    id: 'guts',
    name: 'Drain',
    marquee: 'DRAIN',
    layoutHint: 'per-player',
    minPlayers: 2,
    fitsPlayers: (n) => n >= 2 && n <= 6,
    deal(v) {
      for (const id of v.hand.inHand)
        v.hand.playerCards[id] = { cards: [v.draw()], faceUp: [false] };
      return { kind: 'betting', street: 'only' };
    },
    nextPhase: () => ({ kind: 'showdown' }),
    score: (hand, id) => (hand.inHand[0] === id ? 100 : 1),
    describeScore: () => 'drain',
    bot: { decideBet: () => ({ move: 'check' }) },
  };
}

/** Everyone (winner included) pays their whole stack forward: total wipeout. */
const drainAll: GameVariant = {
  ...drainBase(),
  settle(v) {
    const payments: Record<string, number> = {};
    for (const id of v.hand.inHand) payments[id] = 999;
    return { payments, carry: 0 };
  },
};

/** Only the losers pay their whole stack forward. */
const drainLosers: GameVariant = {
  ...drainBase(),
  settle(v) {
    const payments: Record<string, number> = {};
    for (const id of v.hand.inHand.slice(1)) payments[id] = 999;
    return { payments, carry: 0 };
  },
};

// ---------------------------------------------------------------------------
// Error codes and messages
// ---------------------------------------------------------------------------

describe('error messages are exact', () => {
  it('seating and lobby guards', () => {
    const t = new Table(2);
    expectFail(
      t.tryApply({ type: 'approveSeat', byId: 'p1', playerId: 'x' }),
      'not-host',
      'Only the host can do that'
    );
    expectFail(
      t.tryApply({ type: 'requestSeat', playerId: 'p1', name: 'Again', seat: 0 }),
      'noop',
      'Already in the game'
    );
    expectFail(
      t.tryApply({ type: 'requestSeat', playerId: 'x', name: '   ', seat: 0 }),
      'bad-amount',
      'Name required'
    );
    expectFail(
      t.tryApply({ type: 'approveSeat', byId: 'p0', playerId: 'ghost' }),
      'unknown-player',
      'No such seat request'
    );
    expectFail(
      t.tryApply({ type: 'kick', byId: 'p0', playerId: 'p0' }),
      'illegal-move',
      'Host cannot kick self'
    );
    expectFail(
      t.tryApply({ type: 'kick', byId: 'p0', playerId: 'ghost' }),
      'unknown-player',
      'No such player'
    );
    expectFail(
      t.tryApply({ type: 'leave', playerId: 'ghost' }),
      'unknown-player',
      'No such player'
    );
    expectFail(
      t.tryApply({ type: 'imBack', playerId: 'ghost' }),
      'unknown-player',
      'No such player'
    );
    expectFail(
      t.tryApply({ type: 'removeBot', byId: 'p0', playerId: 'p1' }),
      'unknown-player',
      'No such bot'
    );
    expectFail(t.tryApply({ type: 'pause', byId: 'p0' }), 'bad-phase', 'Nothing to pause');
    expectFail(t.tryApply({ type: 'resume', byId: 'p0' }), 'bad-phase', 'Not paused');
    expectFail(t.tryAct('p1', 'check'), 'bad-phase', 'No hand in progress');
    expectFail(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'flip' } }),
      'bad-phase',
      'No hand in progress'
    );
    expectFail(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' }),
      'bad-phase',
      'No game selection pending'
    );
    expectFail(
      t.tryApply({ type: 'chooseTimeout' }),
      'bad-phase',
      'No game selection pending'
    );
    expectFail(t.tryApply({ type: 'timeout' }), 'bad-phase', 'No hand');
    expectFail(t.tryApply({ type: 'nextHand' }), 'bad-phase', 'No hand pending');
    expectFail(
      t.tryApply({ type: 'topUp', playerId: 'ghost' }),
      'unknown-player',
      'No such player'
    );
    expectFail(t.tryTopUp('p1'), 'bad-phase', 'Game has not started');
  });

  it('startGame guards', () => {
    expectFail(
      new Table(1).tryApply({ type: 'startGame', byId: 'p0' }),
      'bad-phase',
      'Need at least 2 players'
    );
    const t = new Table(2);
    t.start();
    expectFail(
      t.tryApply({ type: 'startGame', byId: 'p0' }),
      'bad-phase',
      'Game already started'
    );
  });

  it('in-play guards', () => {
    const t = new Table(3);
    t.start();
    expectFail(t.tryAct('p2', 'check'), 'not-your-turn', 'Not your turn');
    expectFail(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'flip' } }),
      'not-your-turn',
      'Not your turn'
    );
    expectFail(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'flip' } }),
      'illegal-move',
      'Not an exchange round'
    );
    t.now = t.hand.round.actionDeadline! - 1;
    expectFail(t.tryApply({ type: 'timeout' }), 'not-expired', 'Timer has not expired');
    expectFail(t.tryApply({ type: 'nextHand' }), 'bad-phase', 'No hand pending');
    t.foldAround();
    expectFail(t.tryApply({ type: 'nextHand' }), 'not-expired', 'Next hand not due yet');
    expectFail(t.tryTopUp('p1'), 'illegal-move', 'You still have chips');
  });

  it('after-end guards', () => {
    const t = new Table(2);
    t.apply({ type: 'endGame', byId: 'p0' });
    expectFail(
      t.tryApply({ type: 'requestSeat', playerId: 'x', name: 'X', seat: 0 }),
      'bad-phase',
      'Game is over'
    );
    expectFail(t.tryApply({ type: 'addBot', byId: 'p0' }), 'bad-phase', 'Game is over');
    expectFail(
      t.tryApply({ type: 'endGame', byId: 'p0' }),
      'bad-phase',
      'Game is already over'
    );
    expectFail(t.tryTopUp('p1'), 'bad-phase', 'Game is over');
  });

  it('addBot on a full table', () => {
    const full = new Table(6);
    expectFail(full.tryApply({ type: 'addBot', byId: 'p0' }), 'game-full', 'No open seat');
  });

  it('approveSeat with a full all-human table', () => {
    const t = new Table(5);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 5 });
    t.apply({ type: 'requestSeat', playerId: 'py', name: 'Py', seat: 5 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'px' });
    expectFail(
      t.tryApply({ type: 'approveSeat', byId: 'p0', playerId: 'py' }),
      'game-full',
      'Table is full'
    );
  });

  it('exhausted top-up schedule while the game continues', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.state.players['p2'].topUpsUsed = 2;
    t.start();
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'check');
    t.act('p2', 'bet', 3);
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.players['p2'].status).toBe('busted');
    expectFail(t.tryTopUp('p2'), 'illegal-move', 'No top-ups remaining');
  });
});

describe('denySeat matches only the named request', () => {
  it('an unknown target errors even while other requests are pending', () => {
    const t = new Table(1);
    t.apply({ type: 'requestSeat', playerId: 'rx', name: 'Rex', seat: 1 });
    expectFail(
      t.tryApply({ type: 'denySeat', byId: 'p0', playerId: 'ghost' }),
      'unknown-player',
      'No such seat request'
    );
    expect(t.state.seatRequests.map((r) => r.playerId)).toEqual(['rx']);
  });
});

describe('requestSeat room check counts only SEATED bots', () => {
  it('an unseated (removed) bot does not make room on a full human table', () => {
    const t = new Table(5);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    t.apply({ type: 'removeBot', byId: 'p0', playerId: botId });
    t.apply({ type: 'requestSeat', playerId: 'h6', name: 'H6', seat: 5 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'h6' });
    // 6 humans seated; the leftover bot player has no seat to yield.
    expectFail(
      t.tryApply({ type: 'requestSeat', playerId: 'h7', name: 'H7', seat: 0 }),
      'game-full',
      'Table is full'
    );
  });
});

// ---------------------------------------------------------------------------
// normalizeConfig
// ---------------------------------------------------------------------------

describe('normalizeConfig edge pins', () => {
  it('a non-finite minBet falls back to exactly 2x ante', () => {
    expect(normalizeConfig({ ante: 5, minBet: NaN }).minBet).toBe(10);
  });

  it('non-string enabledVariants entries are dropped even if they coerce to a variant id', () => {
    const sneaky = [['holdem']] as unknown as TableConfig['enabledVariants'];
    expect(normalizeConfig({ enabledVariants: sneaky }).enabledVariants).toEqual(['holdem']);
  });
});

// ---------------------------------------------------------------------------
// Choosing phase: deadlines, botChooseAt, dealer away/back
// ---------------------------------------------------------------------------

const BOTH = { enabledVariants: ['holdem', 'five-draw'] as ('holdem' | 'five-draw')[] };

describe('chooseTimeout', () => {
  it('errors with the exact message before the deadline and fires exactly AT it', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    expect(t.state.choosing!.deadline).toBe(NOW + 20_000);
    t.now = NOW + 19_999;
    expectFail(
      t.tryApply({ type: 'chooseTimeout' }),
      'not-expired',
      'The dealer still has time'
    );
    t.now = NOW + 20_000; // exact boundary
    const evs = okEvents(t.tryApply({ type: 'chooseTimeout' }));
    // Absent human dealer goes away with an exact payload, then auto-pick.
    expect(types(evs).slice(0, 2)).toEqual(['player-away', 'game-chosen']);
    expect(data(evs[0])).toEqual({ playerId: 'p0' });
    expect(data(evs[1])).toEqual({
      dealerId: 'p0',
      variant: 'holdem',
      variantName: "Texas Hold'em",
      auto: true,
    });
    expect(t.state.players['p0'].status).toBe('away');
    expect(t.state.phase).toBe('playing');
  });

  it('an already-away dealer is not re-marked away', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.state.players['p0'].status = 'away';
    t.now = NOW + 20_000;
    const evs = okEvents(t.tryApply({ type: 'chooseTimeout' }));
    expect(types(evs)).not.toContain('player-away');
    expect(t.state.players['p0'].status).toBe('away');
  });

  it('a bot dealer gets botChooseAt = now + 800 + jitter and is never marked away', () => {
    const t = new Table(1, { config: BOTH, rand: (n) => n - 1 });
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    t.start();
    // rand(2) = 1: the bot's seat wins the first button.
    expect(t.state.choosing).toMatchObject({
      dealerId: botId,
      buttonSeat: 1,
      deadline: NOW + 20_000,
      botChooseAt: NOW + 800 + 1399, // BASE 800 + randInt(1400) = 1399
    });
    t.now = NOW + 20_000;
    const evs = okEvents(t.tryApply({ type: 'chooseTimeout' }));
    expect(types(evs)).not.toContain('player-away');
    expect(t.state.players[botId].status).toBe('seated');
    expect(t.state.phase).toBe('playing');
  });

  it('guards hold even if phase and choosing state disagree', () => {
    const t = new Table(2, { config: BOTH });
    t.start();
    t.state.phase = 'playing'; // choosing object left behind
    expectError(t.tryApply({ type: 'chooseTimeout' }), 'bad-phase');
    const t2 = new Table(2);
    t2.state.phase = 'choosing'; // no choosing object
    expectError(t2.tryApply({ type: 'chooseTimeout' }), 'bad-phase');
  });
});

describe('chooseGame', () => {
  it('rejects a pick the table cannot support, with the exact message', () => {
    register({ ...drainBase(), name: 'Misfit', minPlayers: 3, fitsPlayers: () => true });
    const t = new Table(2, { config: { enabledVariants: ['holdem', 'guts'] } });
    t.start();
    expectFail(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'guts' }),
      'illegal-move',
      'Misfit does not fit this table'
    );
    expectFail(
      t.tryApply({ type: 'chooseGame', playerId: 'p1', variant: 'holdem' }),
      'not-your-turn',
      "It's not your deal"
    );
    expectFail(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'baseball' }),
      'illegal-move',
      'That game is not enabled'
    );
  });

  it('an away dealer picking comes back with a player-back event; a seated dealer emits none', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.state.players['p0'].status = 'away';
    const evs = okEvents(t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'five-draw' }));
    expect(types(evs)[0]).toBe('player-back');
    expect(data(evs[0])).toEqual({ playerId: 'p0' });
    expect(data(evs[1])).toMatchObject({ dealerId: 'p0', variant: 'five-draw', auto: false });
    expect(t.state.players['p0'].status).toBe('seated');

    const t2 = new Table(3, { config: BOTH });
    t2.start();
    const evs2 = okEvents(t2.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' }));
    expect(types(evs2)).not.toContain('player-back');
  });

  it('guards hold even if phase and choosing state disagree', () => {
    const t = new Table(2, { config: BOTH });
    t.start();
    t.state.phase = 'playing';
    expectError(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' }),
      'bad-phase'
    );
    const t2 = new Table(2);
    t2.state.phase = 'choosing';
    expectError(
      t2.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' }),
      'bad-phase'
    );
  });
});

describe('defaultVariant', () => {
  it('repeats the previous variant only while it stays enabled', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold');
    expect(defaultVariant(t.state)).toBe('holdem');
    t.state.config.enabledVariants = ['five-draw'];
    expect(defaultVariant(t.state)).toBe('five-draw');
  });
});

describe('leaving during the choosing phase', () => {
  it('holds a top-up window instead of dealing on (or ending) when a rebuy could save the game', () => {
    const t = new Table(3, { config: BOTH, stacks: [50, 50, 4] });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'check');
    t.act('p2', 'bet', 3);
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.players['p2'].status).toBe('busted');
    t.nextHand(); // re-enters choosing (dealer p1)
    expect(t.state.phase).toBe('choosing');
    t.apply({ type: 'leave', playerId: 'p1' });
    expect(t.state.phase).toBe('hand-over'); // held open for p2's rebuy, NOT ended
    expect(t.state.choosing).toBeNull();
    expect(t.state.nextHandAt).toBe(t.now + 20_000);
    const win = eventsOf(t.state, 'top-up-window').at(-1)!;
    expect(data(win)).toEqual({ until: t.now + 20_000, playerIds: ['p2'] });
  });
});

// ---------------------------------------------------------------------------
// Communal pot (hand.pot) plumbing
// ---------------------------------------------------------------------------

describe('communal pot', () => {
  it('variantMove emits an exact action payload; communal antes-posted totals hand.pot', () => {
    register(grab);
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    expect(data(eventsOf(t.state, 'antes-posted')[0])).toEqual({
      amount: 2,
      playerIds: ['p1', 'p2', 'p0'],
      potTotal: 6,
    });
    const evs = okEvents(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 4 } })
    );
    expect(types(evs)).toEqual(['action', 'turn']);
    expect(data(evs[0])).toEqual({
      playerId: 'p1',
      move: 'grab',
      detail: { win: 4 },
      street: 'grab',
      auto: false,
    });
    expect(t.hand.pot).toBe(2);
  });

  it('an emptied pot carries nothing: no pot-carried event; custom resolve drives hand-result', () => {
    register(grab);
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 4 } });
    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'wager', amount: 2 } });
    t.apply({ type: 'variantMove', playerId: 'p0', move: { kind: 'wager', amount: 0 } });
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(0);
    expect(types(t.state.events)).not.toContain('pot-carried');
    const result = eventsOf(t.state, 'hand-result')[0];
    expect(data(result).kind).toBe('showdown');
    expect(data(result).descriptions).toEqual({ note: 'custom-resolve' }); // custom resolve, not showdown scoring
    expect(t.state.nextHandAt).toBe(t.now + 5000);
  });

  it('a leftover pot emits pot-carried with the exact amount', () => {
    register(grab);
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    for (const id of [...t.hand.inHand]) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
    }
    const carried = eventsOf(t.state, 'pot-carried');
    expect(carried).toHaveLength(1);
    expect(data(carried[0])).toEqual({ amount: 6 });
    expect(t.state.carryPot).toBe(6);
  });

  it('an away player acting a variantMove comes back; seated players emit no player-back', () => {
    register(grab);
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    t.state.players['p1'].status = 'away';
    const evs = okEvents(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 0 } })
    );
    expect(types(evs)).toEqual(['player-back', 'action', 'turn']);
    expect(data(evs[0])).toEqual({ playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
    const evs2 = okEvents(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'wager', amount: 0 } })
    );
    expect(types(evs2)).not.toContain('player-back');
  });

  it('a communal-pot game WITHOUT a custom resolve carries an unwon pot at showdown', () => {
    register({
      ...drainBase(),
      id: 'baseball',
      name: 'PlainCommunal',
      potStyle: 'communal',
      score: () => 5,
    });
    const t = new Table(2, { config: { enabledVariants: ['baseball'], ante: 1 } });
    t.start();
    expect(t.hand.pot).toBe(2);
    t.checkDown();
    // No committed chips => no pots => nobody "wins" the communal fund.
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(2);
    expect(data(eventsOf(t.state, 'pot-carried')[0])).toEqual({ amount: 2 });
    expect(t.stack('p0')).toBe(19);
    expect(t.stack('p1')).toBe(19);
  });
});

describe('communal pot award to winners', () => {
  it('splits an odd carried pot with the remainder to the first winner clockwise', () => {
    const t = new Table(2);
    t.state.carryPot = 5;
    t.start();
    expect(t.hand.pot).toBe(5);
    expect(data(eventsOf(t.state, 'hand-started')[0]).carried).toBe(5);
    // Royal flush on the board: a dead tie between p1 and p0.
    t.rig({ p0: ['2c', '3c'], p1: ['2d', '3d'] }, ['Ah', 'Kh', 'Qh', 'Jh', 'Th']);
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    // Antes split 1/1; hand.pot 5 splits 3 (first clockwise = p1) / 2.
    expect(t.stack('p1')).toBe(23);
    expect(t.stack('p0')).toBe(22);
    expect(t.state.carryPot).toBe(0);
    const pots = data(eventsOf(t.state, 'hand-result')[0]).pots as { amount: number }[];
    expect(pots[0].amount).toBe(7); // 2 antes + the carried 5 folded into the awarded pot
    expect(t.totalChips()).toBe(45);
  });
});

// ---------------------------------------------------------------------------
// Settle hook (pot matching)
// ---------------------------------------------------------------------------

describe('settle hook', () => {
  it('skips zero payments (no pot-matched event) and adds settled.carry to the carry pot', () => {
    register({
      ...drainBase(),
      settle(v) {
        return {
          payments: { [v.hand.inHand[1]]: 5, [v.hand.inHand[2]]: 0 },
          carry: 7,
        };
      },
    });
    const t = new Table(3, { config: { enabledVariants: ['guts'], ante: 1 } });
    t.start();
    t.checkDown();
    const matched = eventsOf(t.state, 'pot-matched');
    expect(matched).toHaveLength(1);
    expect(data(matched[0])).toEqual({ playerId: 'p2', amount: 5 });
    expect(t.state.carryPot).toBe(12); // 5 collected + 7 carry
    expect(t.state.phase).toBe('hand-over');
  });
});

// ---------------------------------------------------------------------------
// All-busted table: hold, rebuy shortening, and end-of-game disbursement
// ---------------------------------------------------------------------------

/** Heads-up drainAll game where the settle hook busts BOTH players. */
function bustEveryone(config: Partial<TableConfig> = {}): Table {
  register(drainAll);
  const t = new Table(2, {
    config: { enabledVariants: ['guts'], ante: 1, ...config },
    stacks: [20, 21],
  });
  t.start();
  if (t.state.phase === 'choosing') {
    t.apply({ type: 'chooseGame', playerId: t.state.choosing!.dealerId, variant: 'guts' });
  }
  t.checkDown();
  expect(t.state.players['p0'].status).toBe('busted');
  expect(t.state.players['p1'].status).toBe('busted');
  expect(t.state.carryPot).toBe(41);
  return t;
}

describe('all-busted hold and disbursement', () => {
  it('holds a rebuy window; expiry ends with no winner and splits the carry (remainder by seat order)', () => {
    const t = bustEveryone();
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.nextHandAt).toBe(NOW + 20_000);
    expect(data(eventsOf(t.state, 'top-up-window')[0])).toEqual({
      until: NOW + 20_000,
      playerIds: ['p0', 'p1'],
    });
    // A pending (unseated) requester must never receive carry chips.
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 2 });
    t.now = NOW + 20_001;
    t.apply({ type: 'nextHand' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('lastPlayer');
    const ended = eventsOf(t.state, 'game-ended').at(-1)!;
    expect(data(ended)).toEqual({ winnerId: null, reason: 'lastPlayer' });
    // 41 split by seat order: p0 gets 21 (odd chip), p1 gets 20; both un-busted.
    expect(t.stack('p0')).toBe(21);
    expect(t.stack('p1')).toBe(20);
    expect(t.state.players['p0'].status).toBe('seated');
    expect(t.state.players['p1'].status).toBe('seated');
    expect(t.stack('px')).toBe(20);
    expect(t.state.carryPot).toBe(0);
  });

  it('the same expiry through the CHOOSING flow (beginHand) also ends cleanly', () => {
    const t = bustEveryone({ enabledVariants: ['guts', 'holdem'] });
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 2 });
    t.now = t.state.nextHandAt! + 1;
    t.apply({ type: 'nextHand' });
    expect(t.state.phase).toBe('ended');
    expect(data(eventsOf(t.state, 'game-ended').at(-1)!)).toEqual({
      winnerId: null,
      reason: 'lastPlayer',
    });
    expect(t.stack('p0')).toBe(21);
    expect(t.stack('p1')).toBe(20);
    expect(t.stack('px')).toBe(20);
  });

  it('a rebuy that still leaves fewer than 2 chipped players does NOT shorten the window', () => {
    const t = bustEveryone();
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 2 });
    t.topUp('p0');
    expect(t.stack('p0')).toBe(12);
    expect(t.state.players['p0'].status).toBe('seated');
    // p1 is still busted and px is unseated: only 1 chipped player => keep waiting.
    expect(t.state.nextHandAt).toBe(NOW + 20_000);
  });
});

describe('single-rebuyer window expiring through beginHand', () => {
  it('ends the game in favor of the surviving player (exact winnerId)', () => {
    register(drainLosers);
    const t = new Table(2, { config: { enabledVariants: ['guts', 'holdem'], ante: 1 } });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'guts' });
    t.checkDown();
    // p1 (first in hand order) won and p0 paid everything forward.
    expect(t.state.players['p0'].status).toBe('busted');
    expect(t.state.carryPot).toBe(19);
    expect(t.state.phase).toBe('hand-over');
    expect(data(eventsOf(t.state, 'top-up-window')[0]).playerIds).toEqual(['p0']);
    t.now = t.state.nextHandAt! + 1;
    t.apply({ type: 'nextHand' });
    expect(t.state.phase).toBe('ended');
    expect(data(eventsOf(t.state, 'game-ended').at(-1)!)).toEqual({
      winnerId: 'p1',
      reason: 'lastPlayer',
    });
    // The live player alone collects the carry; the busted one gets nothing.
    expect(t.stack('p1')).toBe(40);
    expect(t.stack('p0')).toBe(0);
    expect(t.state.players['p0'].status).toBe('busted');
  });
});

describe('endGame disbursement recipients', () => {
  it('live seated players split the carry; a busted spectator gets nothing and stays busted', () => {
    register(grab);
    const t = new Table(3, {
      config: { enabledVariants: ['in-between'], ante: 2 },
      stacks: [20, 20, 2],
    });
    t.start(); // p2 antes all-in
    for (const id of [...t.hand.inHand]) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
    }
    expect(t.state.players['p2'].status).toBe('busted');
    expect(t.state.carryPot).toBe(6);
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.stack('p0')).toBe(21);
    expect(t.stack('p1')).toBe(21);
    expect(t.stack('p2')).toBe(0);
    expect(t.state.players['p2'].status).toBe('busted');
    expect(t.state.carryPot).toBe(0);
    expect(data(eventsOf(t.state, 'game-ended').at(-1)!)).toEqual({
      winnerId: null,
      reason: 'host',
    });
  });

  it('with no seats occupied the carry falls back to every player, without un-busting the living', () => {
    const t = new Table(2);
    t.state.players['p0'].status = 'left';
    t.state.players['p1'].status = 'left';
    t.state.players['p0'].seat = null;
    t.state.players['p1'].seat = null;
    t.state.seats = [null, null, null, null, null, null];
    t.state.carryPot = 5;
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.stack('p0')).toBe(23); // 20 + 3 (odd chip first in player order)
    expect(t.stack('p1')).toBe(22);
    expect(t.state.players['p0'].status).toBe('left');
    expect(t.state.players['p1'].status).toBe('left');
    expect(t.state.carryPot).toBe(0);
  });

  it('a zero share never un-busts: only recipients who actually receive chips revive', () => {
    const t = new Table(2);
    for (const id of ['p0', 'p1']) {
      t.state.players[id].status = 'busted';
      t.state.players[id].stack = 0;
    }
    t.state.carryPot = 1;
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.players['p0']).toMatchObject({ stack: 1, status: 'seated' });
    expect(t.state.players['p1']).toMatchObject({ stack: 0, status: 'busted' });
  });
});

// ---------------------------------------------------------------------------
// topUp guard boundaries (states the engine itself would not produce)
// ---------------------------------------------------------------------------

/** Heads-up: p1 shoves into p0's aces and busts (holding window opens). */
function bustP1(t: Table): void {
  t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  t.act('p1', 'bet', t.stack('p1') + (t.hand.round.committed['p1'] ?? 0));
  t.act('p0', 'call');
  expect(t.state.players['p1'].status).toBe('busted');
}

describe('topUp guards', () => {
  it('a busted player without a seat cannot top up', () => {
    const t = new Table(2);
    t.start();
    bustP1(t);
    t.state.seats[1] = null;
    t.state.players['p1'].seat = null;
    expectFail(t.tryTopUp('p1'), 'illegal-move', 'You still have chips');
  });

  it('never reschedules when hand-over has no pending next hand', () => {
    const t = new Table(2);
    t.start();
    bustP1(t);
    t.state.nextHandAt = null;
    t.topUp('p1');
    expect(t.state.nextHandAt).toBeNull();
  });

  it('never reschedules outside the hand-over phase even with nextHandAt set', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.start();
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'check');
    t.act('p2', 'bet', 3);
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    t.nextHand();
    expect(t.state.phase).toBe('playing');
    t.state.nextHandAt = t.now + 99_999;
    t.topUp('p2');
    expect(t.state.phase).toBe('playing');
    expect(t.state.nextHandAt).toBe(t.now + 99_999);
  });
});

// ---------------------------------------------------------------------------
// timeout: exchange rounds, time bank, and guard clauses
// ---------------------------------------------------------------------------

describe('timeout on exchange rounds', () => {
  it('auto-moves settle the round: every player timing out ends the hand', () => {
    register(grab);
    const t = new Table(3, {
      config: { enabledVariants: ['in-between'], ante: 2, timeBankMs: 0 },
    });
    t.start();
    for (let i = 0; i < 3; i++) {
      t.now = t.hand.round.actionDeadline! + 1;
      t.apply({ type: 'timeout' });
    }
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(6);
    expect(eventsOf(t.state, 'player-away')).toHaveLength(3);
  });

  it('multi-step forced turns mark the player away exactly once, with the exact payload', () => {
    register({
      ...drainBase(),
      id: 'five-draw',
      name: 'Stepper',
      deal(v) {
        for (const id of v.hand.inHand) v.hand.playerCards[id] = { cards: [], faceUp: [] };
        return { kind: 'exchange', street: 'step' };
      },
      exchange: {
        legal: () => ({ kind: 'exchange', moves: [{ kind: 'flip' }], autoMove: { kind: 'flip' } }),
        apply(v, playerId) {
          const key = `step-${playerId}`;
          const n = (v.hand.vstate[key] as number | undefined) ?? 0;
          v.hand.vstate[key] = n + 1;
          if (n < 2) return { applied: { move: `flip-${n}` }, turnContinues: true };
          return { applied: { move: 'flip-final' } };
        },
      },
    });
    const t = new Table(2, { config: { enabledVariants: ['five-draw'], timeBankMs: 0 } });
    t.start();
    expect(t.toAct).toBe('p1');
    let guard = 0;
    while (t.state.phase === 'playing') {
      if (guard++ > 20) throw new Error('did not terminate');
      t.now = Math.max(t.now, t.hand.round.actionDeadline!) + 1;
      t.apply({ type: 'timeout' });
    }
    expect(t.state.phase).toBe('hand-over');
    const away = eventsOf(t.state, 'player-away');
    expect(away.map((e) => data(e))).toEqual([{ playerId: 'p1' }, { playerId: 'p0' }]);
  });

  it('a failing auto-move passes the turn silently instead of emitting an action', () => {
    register({
      ...drainBase(),
      id: 'five-draw',
      name: 'Stuck',
      deal(v) {
        for (const id of v.hand.inHand) v.hand.playerCards[id] = { cards: [], faceUp: [] };
        return { kind: 'exchange', street: 'stuck' };
      },
      exchange: {
        legal: () => ({ kind: 'exchange', moves: [{ kind: 'flip' }], autoMove: { kind: 'flip' } }),
        apply: () => ({ error: { code: 'illegal-move', message: 'nope' } }),
      },
    });
    const t = new Table(2, { config: { enabledVariants: ['five-draw'], timeBankMs: 0 } });
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    const evs = okEvents(t.tryApply({ type: 'timeout' }));
    expect(types(evs)).toEqual(['player-away', 'turn']); // no 'action'
    expect(t.toAct).toBe('p0'); // the turn still passed
  });
});

describe('timeout guards and time bank', () => {
  it('with no deadline on the clock, timeout errors with the exact message', () => {
    const t = new Table(2);
    t.start();
    t.state.hand!.round.actionDeadline = null;
    expectFail(t.tryApply({ type: 'timeout' }), 'not-expired', 'No one is on the clock');
  });

  it('a bot never arms a time bank, even if it somehow holds bank time', () => {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    t.start();
    expect(t.toAct).toBe(botId);
    t.state.players[botId].timeBankMs = 5000;
    t.now = t.hand.round.actionDeadline!;
    const evs = okEvents(t.tryApply({ type: 'timeout' }));
    expect(types(evs)).not.toContain('time-bank');
    expect(types(evs)).toContain('action'); // instant auto-check instead
    expect(t.state.players[botId].status).toBe('seated');
  });
});

describe('nextHand guard', () => {
  it('a null nextHandAt in hand-over stays not-expired', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold');
    expect(t.state.phase).toBe('hand-over');
    t.state.nextHandAt = null;
    t.now += 60_000;
    expectFail(t.tryApply({ type: 'nextHand' }), 'not-expired', 'Next hand not due yet');
  });
});

// ---------------------------------------------------------------------------
// imBack guard clauses
// ---------------------------------------------------------------------------

describe('imBack guards', () => {
  it('only a LIVE turn gets a fresh clock: outside playing the deadline is untouched', () => {
    const t = new Table(2);
    t.start();
    const d0 = t.hand.round.actionDeadline!;
    t.state.players['p1'].status = 'away';
    t.state.phase = 'hand-over';
    t.now += 1234;
    t.apply({ type: 'imBack', playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
    expect(t.hand.round.actionDeadline).toBe(d0);
  });

  it('survives a playing phase with no hand object', () => {
    const t = new Table(2);
    t.state.players['p1'].status = 'away';
    t.state.phase = 'playing';
    const evs = okEvents(t.tryApply({ type: 'imBack', playerId: 'p1' }));
    expect(types(evs)).toEqual(['player-back']);
    expect(t.state.players['p1'].status).toBe('seated');
  });
});

// ---------------------------------------------------------------------------
// removePlayer bookkeeping
// ---------------------------------------------------------------------------

describe('removePlayer seat bookkeeping', () => {
  it('an unseated requester leaving never touches the seats array', () => {
    const t = new Table(1);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 1 });
    t.apply({ type: 'leave', playerId: 'px' });
    expect(t.state.players['px'].status).toBe('left');
    expect(t.state.seatRequests).toEqual([]);
    expect(Object.keys(t.state.seats)).toHaveLength(6); // no stray "null" index
    expect(t.state.seats).toEqual(['p0', null, null, null, null, null]);
  });
});

// ---------------------------------------------------------------------------
// Degenerate / contract-edge variants
// ---------------------------------------------------------------------------

describe('variant contract edges', () => {
  it('a variant dealing straight to showdown settles immediately (ante round preserved)', () => {
    register({
      ...drainBase(),
      id: 'five-draw',
      name: 'Instant',
      deal(v) {
        for (const id of v.hand.inHand) v.hand.playerCards[id] = { cards: [], faceUp: [] };
        return { kind: 'showdown' };
      },
    });
    const t = new Table(2, { config: { enabledVariants: ['five-draw'] } });
    t.start();
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    // The never-opened seed round keeps its freshRound shape.
    expect(t.hand.round.street).toBe('ante');
    expect(t.hand.round.kind).toBe('betting');
    expect(t.hand.round.timeBankArmed).toBe(false);
    expect(t.hand.round.toAct).toBeNull();
    expect(data(eventsOf(t.state, 'hand-result')[0]).kind).toBe('showdown');
    expect(t.state.nextHandAt).toBe(NOW + 5000); // showdown pause, not NaN
    expect(t.stack('p1')).toBe(21); // first in hand order wins the antes
    expect(t.stack('p0')).toBe(19);
  });

  it('a betting round whose firstToAct declines is skipped, not stamped', () => {
    register({
      ...drainBase(),
      id: 'five-draw',
      name: 'NullFirst',
      firstToAct: (_state, hand) =>
        hand.round.street === 'two' ? null : hand.inHand[0],
      nextPhase(v) {
        return v.hand.round.street === 'one'
          ? { kind: 'betting', street: 'two' }
          : { kind: 'showdown' };
      },
      deal(v) {
        for (const id of v.hand.inHand)
          v.hand.playerCards[id] = { cards: [v.draw()], faceUp: [false] };
        return { kind: 'betting', street: 'one' };
      },
    });
    const t = new Table(2, { config: { enabledVariants: ['five-draw'] } });
    t.start();
    t.act('p1', 'check');
    t.act('p0', 'check');
    // Round 'two' had no opener: straight to showdown without a crash.
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
  });
});
