import { describe, expect, it } from 'vitest';
import { Table, expectError, NOW } from './test-utils';
import { normalizeConfig } from './engine';
import type { EngineResult, GameEvent, GameState } from './types';

/**
 * Mutation-hardening suite for src/engine/engine.ts. Each test pins a rule
 * whose Stryker mutants survived the original suite: validation guards, event
 * payloads/ordering, deadline stamping boundaries, away/time-bank semantics,
 * kick/leave paths, bot creation, and the event ring buffer.
 *
 * Layout with zeroRand: first-hand button = seat 0 (p0); hand order is
 * clockwise from its left with the button last (3-handed: p1, p2, p0), and
 * p1 opens every street.
 */

const data = (e: GameEvent) => e.data as Record<string, unknown>;
const types = (evs: GameEvent[]) => evs.map((e) => e.type);
const eventsOf = (state: GameState, type: string) =>
  state.events.filter((e) => e.type === type);

function okEvents(res: EngineResult): GameEvent[] {
  if (!res.ok) throw new Error(`unexpected error ${res.error.code}: ${res.error.message}`);
  return res.events;
}

/** Heads-up (zeroRand: p0 = button, p1 opens): p1 shoves, p0 calls, p1 busts. */
function bustP1HeadsUp(t: Table): void {
  t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  t.act('p1', 'bet', t.stack('p1') + (t.hand.round.committed['p1'] ?? 0));
  t.act('p0', 'call');
  expect(t.state.players['p1'].status).toBe('busted');
}

/** 3-handed: p1 burns their bank and goes away in hand 1; hand 2 reaches p1's turn. */
function awayP1OnTurn(): Table {
  const t = new Table(3);
  t.start();
  t.now = t.hand.round.actionDeadline! + 1;
  t.apply({ type: 'timeout' }); // arms the time bank
  t.now = t.hand.round.actionDeadline! + 1;
  t.apply({ type: 'timeout' }); // p1 auto-checks and goes away
  t.act('p2', 'fold');
  t.act('p0', 'fold'); // p1 wins hand 1
  t.nextHand(); // hand 2: button seat 1, order p2, p0, p1
  t.act('p2', 'check');
  t.act('p0', 'check');
  expect(t.toAct).toBe('p1');
  return t;
}

// ---------------------------------------------------------------------------

describe('config normalization', () => {
  it('non-finite config values fall back to defaults instead of leaking NaN', () => {
    const cfg = normalizeConfig({ startingStack: NaN, actionTimeMs: NaN });
    expect(cfg.startingStack).toBe(20);
    expect(cfg.actionTimeMs).toBe(20_000);
  });

  it('ante defaults to 1; minBet defaults to 2×ante and never sits below the ante', () => {
    const cfg = normalizeConfig({});
    expect(cfg.ante).toBe(1);
    expect(cfg.minBet).toBe(2);
    expect(normalizeConfig({ ante: 0 }).ante).toBe(1); // clamp floor
    expect(normalizeConfig({ ante: 5 }).minBet).toBe(10); // 2×ante default
    expect(normalizeConfig({ ante: 5, minBet: 3 }).minBet).toBe(5); // floor = ante
    expect(normalizeConfig({ ante: 999 }).ante).toBe(20); // cap = startingStack
  });

  it('enabledVariants keeps only implemented ids, dedupes, and never goes empty', () => {
    expect(normalizeConfig({}).enabledVariants).toEqual(['holdem']);
    expect(normalizeConfig({ enabledVariants: ['holdem', 'holdem'] }).enabledVariants)
      .toEqual(['holdem']);
    expect(normalizeConfig({ enabledVariants: ['five-draw'] }).enabledVariants)
      .toEqual(['five-draw']); // implemented since M3
    expect(
      normalizeConfig({ enabledVariants: ['not-a-game' as unknown as 'holdem'] })
        .enabledVariants
    ).toEqual(['holdem']); // unknown id filtered, fallback applied
    expect(
      normalizeConfig({ enabledVariants: 'nope' as unknown as [] }).enabledVariants
    ).toEqual(['holdem']);
  });
});

describe('game creation', () => {
  it('a new game has an empty event log and correct host flags', () => {
    const s = new Table(1).state;
    expect(s.events).toEqual([]);
    expect(s.eventSeq).toBe(0);
    expect(s.players['p0'].isHost).toBe(true);
    expect(s.choosing).toBeNull();
  });
});

describe('event ring buffer', () => {
  it('caps at 100 events, keeping the newest, with strictly increasing seq', () => {
    const t = new Table(1);
    for (let i = 0; i < 60; i++) {
      t.apply({ type: 'requestSeat', playerId: `u${i}`, name: `U${i}`, seat: 0 });
      t.apply({ type: 'denySeat', byId: 'p0', playerId: `u${i}` });
    }
    expect(t.state.eventSeq).toBe(120);
    expect(t.state.events).toHaveLength(100);
    expect(t.state.events[0].seq).toBe(21);
    expect(t.state.events[99].seq).toBe(120);
  });
});

describe('requestSeat', () => {
  it('trims and truncates the name, emits seat-requested, joiner is not host', () => {
    const t = new Table(1);
    expectError(
      t.tryApply({ type: 'requestSeat', playerId: 'a', name: '   ', seat: 0 }),
      'bad-amount'
    );
    const res = t.tryApply({
      type: 'requestSeat',
      playerId: 'b',
      name: `  ${'x'.repeat(30)}  `,
      seat: 3,
    });
    const evs = okEvents(res);
    const name = 'x'.repeat(20);
    expect(types(evs)).toEqual(['seat-requested']);
    expect(data(evs[0])).toEqual({ playerId: 'b', name });
    expect(t.state.players['b'].name).toBe(name);
    expect(t.state.players['b'].isHost).toBe(false);
    expect(t.state.seatRequests[0].seat).toBe(3);
  });

  it('an existing player re-requesting is a noop error', () => {
    const t = new Table(2);
    expectError(
      t.tryApply({ type: 'requestSeat', playerId: 'p1', name: 'Again', seat: 0 }),
      'noop'
    );
  });

  it('a table full of humans rejects new requests', () => {
    const t = new Table(6);
    expectError(
      t.tryApply({ type: 'requestSeat', playerId: 'p6', name: 'P6', seat: 0 }),
      'game-full'
    );
  });
});

describe('approveSeat', () => {
  it('seats exactly the approved player at their requested seat, others stay pending', () => {
    const t = new Table(1);
    t.apply({ type: 'requestSeat', playerId: 'rx', name: 'Rex', seat: 4 });
    t.apply({ type: 'requestSeat', playerId: 'ry', name: 'Rye', seat: 5 });
    const res = t.tryApply({ type: 'approveSeat', byId: 'p0', playerId: 'ry' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['player-seated']);
    expect(data(evs[0])).toEqual({ playerId: 'ry', name: 'Rye', seat: 5 });
    expect(t.seatOf('ry')).toBe(5);
    expect(t.state.seatRequests.map((r) => r.playerId)).toEqual(['rx']);
    expectError(
      t.tryApply({ type: 'approveSeat', byId: 'p0', playerId: 'ghost' }),
      'unknown-player'
    );
  });

  it('with a full all-human table approval fails instead of evicting anyone', () => {
    const t = new Table(5);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 5 });
    t.apply({ type: 'requestSeat', playerId: 'py', name: 'Py', seat: 5 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'px' });
    expect(t.seatOf('px')).toBe(5);
    expectError(
      t.tryApply({ type: 'approveSeat', byId: 'p0', playerId: 'py' }),
      'game-full'
    );
  });

  it('a full table evicts the newest bot — never a seated human', () => {
    const t = new Table(1);
    for (let i = 0; i < 5; i++) t.apply({ type: 'addBot', byId: 'p0' });
    const botIds = Object.values(t.state.players)
      .filter((p) => p.isBot)
      .map((p) => p.id);
    t.apply({ type: 'requestSeat', playerId: 'h2', name: 'Hana', seat: 0 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'h2' });
    expect(t.state.players[botIds[4]].status).toBe('left');
    expect(t.seatOf('h2')).toBe(5);
    t.apply({ type: 'requestSeat', playerId: 'h3', name: 'Hiro', seat: 0 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'h3' });
    expect(t.state.players[botIds[3]].status).toBe('left');
    expect(t.seatOf('h2')).toBe(5); // the earlier human kept their seat
    expect(t.seatOf('h3')).toBe(4);
    expect(t.state.players['h3'].status).toBe('seated');
  });
});

describe('denySeat', () => {
  it('is host-only, requires a pending request, and removes only the denied player', () => {
    const t = new Table(1);
    expectError(
      t.tryApply({ type: 'denySeat', byId: 'p0', playerId: 'ghost' }),
      'unknown-player'
    );
    t.apply({ type: 'requestSeat', playerId: 'rx', name: 'Rex', seat: 1 });
    t.apply({ type: 'requestSeat', playerId: 'ry', name: 'Rye', seat: 2 });
    expectError(t.tryApply({ type: 'denySeat', byId: 'rx', playerId: 'ry' }), 'not-host');
    const res = t.tryApply({ type: 'denySeat', byId: 'p0', playerId: 'rx' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['seat-denied']);
    expect(data(evs[0])).toEqual({ playerId: 'rx' });
    expect(t.state.players['rx']).toBeUndefined();
    expect(t.state.seatRequests.map((r) => r.playerId)).toEqual(['ry']);
  });
});

describe('startGame guards', () => {
  it('requires the lobby phase and at least 2 players', () => {
    expectError(new Table(1).tryApply({ type: 'startGame', byId: 'p0' }), 'bad-phase');
    const t = new Table(2);
    t.start();
    expectError(t.tryApply({ type: 'startGame', byId: 'p0' }), 'bad-phase');
  });
});

describe('ante posting', () => {
  it('hand-started and antes-posted carry exact payloads; antes bypass round.committed', () => {
    const t = new Table(3);
    const res = t.tryApply({ type: 'startGame', byId: 'p0' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['hand-started', 'antes-posted', 'turn']);
    expect(data(evs[0])).toEqual({
      handNo: 1,
      variant: 'holdem',
      variantName: "Texas Hold'em",
      buttonSeat: 0,
      inHand: ['p1', 'p2', 'p0'],
      carried: 0,
    });
    expect(data(evs[1])).toEqual({ amount: 1, playerIds: ['p1', 'p2', 'p0'], potTotal: 3 });
    expect(data(evs[2])).toMatchObject({ playerId: 'p1', street: 'preflop' });
    expect(t.hand.totalCommitted).toEqual({ p0: 1, p1: 1, p2: 1 });
    expect(t.hand.round.committed).toEqual({});
    expect(t.hand.round.currentBet).toBe(0);
    expect(t.hand.round.lastFullRaiseSize).toBe(2); // minBet seeds the round
    expect(t.hand.round.lastFullRaiseTo).toBe(0);
  });

  it('a short stack antes all-in at hand start and is skipped for turns', () => {
    const t = new Table(3, { stacks: [20, 20, 1] });
    t.start();
    expect(t.hand.allIn).toEqual(['p2']);
    expect(t.stack('p2')).toBe(0);
    expect(t.hand.totalCommitted['p2']).toBe(1);
    expect(data(eventsOf(t.state, 'antes-posted')[0]).potTotal).toBe(3);
    expect(t.toAct).toBe('p1');
  });
});

describe('playerAction guards', () => {
  it('rejects actions outside a live hand and out of turn', () => {
    const t = new Table(3);
    expectError(t.tryAct('p1', 'check'), 'bad-phase'); // lobby
    t.start();
    expectError(t.tryAct('p2', 'check'), 'not-your-turn'); // p1 opens
    t.foldAround();
    expectError(t.tryAct('p0', 'check'), 'bad-phase'); // hand-over, hand object still present
  });
});

describe('timeout', () => {
  it('is rejected in the lobby and after the hand is over', () => {
    const t = new Table(3);
    expectError(t.tryApply({ type: 'timeout' }), 'bad-phase');
    t.start();
    t.foldAround();
    expectError(t.tryApply({ type: 'timeout' }), 'bad-phase');
  });

  it('fires exactly at the deadline: bank arms once with payload, then auto-checks', () => {
    const t = new Table(3);
    t.start();
    const d0 = t.hand.round.actionDeadline!;
    t.now = d0; // exact boundary, not past it
    const res = t.tryApply({ type: 'timeout' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['time-bank']);
    expect(data(evs[0])).toEqual({ playerId: 'p1', extraMs: 10_000 });
    expect(t.hand.round.timeBankArmed).toBe(true);
    expect(t.hand.round.actionDeadline).toBe(d0 + 10_000);
    expect(t.toAct).toBe('p1');

    t.now = t.hand.round.actionDeadline! + 1;
    const res2 = t.tryApply({ type: 'timeout' });
    const evs2 = okEvents(res2);
    // Preflop is check-or-bet: the free option auto-checks, never folds.
    expect(types(evs2)).toEqual(['action', 'player-away', 'turn']);
    expect(data(evs2[0])).toEqual({
      playerId: 'p1',
      move: 'check',
      amount: 0,
      street: 'preflop',
      auto: true,
    });
    expect(data(evs2[1])).toEqual({ playerId: 'p1' });
  });

  it('facing a bet the final expiry auto-folds', () => {
    const t = new Table(3);
    t.start();
    t.act('p1', 'bet', 2);
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p2's bank
    t.now = t.hand.round.actionDeadline! + 1;
    const evs = okEvents(t.tryApply({ type: 'timeout' }));
    expect(data(evs[0])).toMatchObject({ playerId: 'p2', move: 'fold', auto: true });
    expect(t.hand.folded).toContain('p2');
    expect(t.state.players['p2'].status).toBe('away');
    expect(t.toAct).toBe('p0');
  });

  it('with timeBankMs 0 the first expiry auto-resolves without arming a bank', () => {
    const t = new Table(2, { config: { timeBankMs: 0 } });
    t.start();
    t.act('p1', 'bet', 2);
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p0 faces a bet: instant fold, no bank
    expect(types(t.state.events)).not.toContain('time-bank');
    expect(t.hand.folded).toContain('p0');
    expect(t.state.players['p0'].status).toBe('away');
  });
});

describe('nextHand', () => {
  it('bad-phase while playing, not-expired before due, fires exactly at nextHandAt', () => {
    const t = new Table(3);
    t.start();
    expectError(t.tryApply({ type: 'nextHand' }), 'bad-phase');
    t.foldAround();
    expect(t.state.nextHandAt).toBe(t.now + 2500); // foldWin pause
    expect(types(t.state.events)).not.toContain('top-up-window');
    expectError(t.tryApply({ type: 'nextHand' }), 'not-expired');
    t.now = t.state.nextHandAt!;
    t.apply({ type: 'nextHand' });
    expect(t.state.phase).toBe('playing');
    expect(t.hand.handNo).toBe(2);
  });

  it('a heads-up fold win takes the normal 2.5s pause, not a rebuy window', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold');
    expect(t.state.nextHandAt).toBe(t.now + 2500);
    expect(types(t.state.events)).not.toContain('top-up-window');
  });
});

describe('pause and resume', () => {
  it('are host-only and phase-guarded', () => {
    const t = new Table(2);
    expectError(t.tryApply({ type: 'pause', byId: 'p1' }), 'not-host');
    expectError(t.tryApply({ type: 'pause', byId: 'p0' }), 'bad-phase');
    expectError(t.tryApply({ type: 'resume', byId: 'p1' }), 'not-host');
    expectError(t.tryApply({ type: 'resume', byId: 'p0' }), 'bad-phase');
  });

  it('pausing between hands pauses immediately; resume schedules the next deal', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold');
    expect(t.state.phase).toBe('hand-over');
    const res = t.tryApply({ type: 'pause', byId: 'p0' });
    expect(types(okEvents(res))).toEqual(['paused']);
    expect(t.state.phase).toBe('paused');
    expect(t.state.nextHandAt).toBeNull();
    const res2 = t.tryApply({ type: 'resume', byId: 'p0' });
    expect(types(okEvents(res2))).toEqual(['resumed']);
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.pauseAfterHand).toBe(false);
    expect(t.state.nextHandAt).toBe(t.now + 1500);
    t.now = t.state.nextHandAt!;
    t.apply({ type: 'nextHand' });
    expect(t.state.phase).toBe('playing');
  });

  it('mid-hand pause defers to hand end and clears the flag once it fires', () => {
    const t = new Table(3);
    t.start();
    const res = t.tryApply({ type: 'pause', byId: 'p0' });
    expect(types(okEvents(res))).toEqual(['pause-requested']);
    expect(t.state.pauseAfterHand).toBe(true);
    t.foldAround();
    expect(t.state.phase).toBe('paused');
    expect(t.state.pauseAfterHand).toBe(false);
    expect(types(t.state.events)).toContain('paused');
  });
});

describe('endGame', () => {
  it('works from the lobby with no hand to refund', () => {
    const t = new Table(2);
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('host');
  });

  it('ending after a completed hand does not double-refund the pot', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold'); // hand resolved: pot already paid out
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.stack('p0') + t.stack('p1')).toBe(40);
  });
});

describe('kick', () => {
  it('guards: the host cannot kick themselves and the target must exist', () => {
    const t = new Table(2);
    expectError(t.tryApply({ type: 'kick', byId: 'p0', playerId: 'p0' }), 'illegal-move');
    expectError(t.tryApply({ type: 'kick', byId: 'p0', playerId: 'ghost' }), 'unknown-player');
  });

  it('kicking a bystander mid-hand never resets the acting clock', () => {
    const t = new Table(3);
    t.start();
    const d0 = t.hand.round.actionDeadline!;
    t.now += 5000;
    t.apply({ type: 'kick', byId: 'p0', playerId: 'p2' });
    expect(t.toAct).toBe('p1');
    expect(t.hand.round.actionDeadline).toBe(d0);
  });

  it('kicking the acting player folds them, advances the turn, restamps the clock', () => {
    const t = new Table(3);
    t.start();
    expect(t.toAct).toBe('p1');
    t.now += 3000;
    const res = t.tryApply({ type: 'kick', byId: 'p0', playerId: 'p1' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['action', 'player-removed', 'turn']);
    expect(data(evs[0])).toMatchObject({ playerId: 'p1', move: 'fold', amount: 0, auto: true });
    expect(data(evs[1])).toEqual({ playerId: 'p1', status: 'kicked' });
    expect(t.toAct).toBe('p2');
    expect(t.hand.round.actionDeadline).toBe(t.now + 20_000);
  });
});

describe('leave', () => {
  it('unknown player errors; a lobby leave frees the seat without ending the game', () => {
    const t = new Table(2);
    expectError(t.tryApply({ type: 'leave', playerId: 'ghost' }), 'unknown-player');
    t.apply({ type: 'leave', playerId: 'p1' });
    expect(t.state.phase).toBe('lobby');
    expect(t.state.players['p1'].status).toBe('left');
    expect(t.state.seats[1]).toBeNull();
  });

  it('a pending requester leaving withdraws only their own request', () => {
    const t = new Table(1);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 1 });
    t.apply({ type: 'requestSeat', playerId: 'py', name: 'Py', seat: 2 });
    t.apply({ type: 'leave', playerId: 'px' });
    expect(t.state.seatRequests.map((r) => r.playerId)).toEqual(['py']);
    expect(t.state.players['px'].status).toBe('left');
  });

  it('leaving after the hand ended does not fold into the finished hand', () => {
    const t = new Table(3);
    t.start();
    t.foldAround(); // p1 and p2 fold; p0 wins
    const foldedBefore = [...t.hand.folded];
    const res = t.tryApply({ type: 'leave', playerId: 'p0' });
    expect(types(okEvents(res))).toEqual(['player-removed']);
    expect(t.hand.folded).toEqual(foldedBefore);
  });

  it('a player who shoved and left before showdown finishes as left, not busted', () => {
    const t = new Table(4, { stacks: [50, 50, 6, 50] });
    t.start(); // antes: p2 has 5 behind
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'], p3: ['3c', '8d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'check');
    t.act('p2', 'bet', 5); // all-in, a full opening bet
    t.act('p3', 'call');
    t.act('p0', 'call');
    t.act('p1', 'call');
    expect(t.hand.round.street).toBe('flop');
    t.apply({ type: 'leave', playerId: 'p2' });
    expect(t.hand.folded).toContain('p2');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.players['p2'].stack).toBe(0);
    expect(t.state.players['p2'].status).toBe('left');
    expect(
      eventsOf(t.state, 'player-busted').filter((e) => data(e).playerId === 'p2')
    ).toHaveLength(0);
  });
});

describe('addBot', () => {
  it('guards: host-only, not after the game ends, not on a full table', () => {
    const t = new Table(2);
    expectError(t.tryApply({ type: 'addBot', byId: 'p1' }), 'not-host');
    const full = new Table(6);
    expectError(full.tryApply({ type: 'addBot', byId: 'p0' }), 'game-full');
    t.apply({ type: 'endGame', byId: 'p0' });
    expectError(t.tryApply({ type: 'addBot', byId: 'p0' }), 'bad-phase');
    expectError(
      t.tryApply({ type: 'requestSeat', playerId: 'z', name: 'Z', seat: 0 }),
      'bad-phase'
    );
  });

  it('bots take the canned names in order, falling back once every name is used', () => {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    t.apply({ type: 'addBot', byId: 'p0' });
    const bots = Object.values(t.state.players).filter((p) => p.isBot);
    expect(bots.map((b) => b.name)).toEqual(['Lucky Lou', 'Raisin Rita']);

    const t2 = new Table(1);
    const canned = ['Lucky Lou', 'Raisin Rita', 'Callin Carl', 'Foldin Fred', 'Bluffy', 'Chip Chaplin'];
    canned.forEach((n, i) =>
      t2.apply({ type: 'requestSeat', playerId: `n${i}`, name: n, seat: 0 })
    );
    t2.apply({ type: 'addBot', byId: 'p0' });
    const bot2 = Object.values(t2.state.players).find((p) => p.isBot)!;
    expect(bot2.name).toMatch(/^Bot \d+$/);
  });

  it('rolls personality from the RNG within bounds and emits a bot-flagged seat event', () => {
    const t = new Table(1, { rand: (n) => n - 1 });
    const res = t.tryApply({ type: 'addBot', byId: 'p0' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['player-seated']);
    const bot = Object.values(t.state.players).find((p) => p.isBot)!;
    expect(data(evs[0])).toMatchObject({ playerId: bot.id, seat: 1, isBot: true });
    expect(bot.isHost).toBe(false);
    // randInt(n) => n-1: 0.3 + 39/100, 0.3 + 49/100, 0.05 + 19/100
    expect(bot.bot!.tightness).toBeCloseTo(0.69, 6);
    expect(bot.bot!.aggression).toBeCloseTo(0.79, 6);
    expect(bot.bot!.bluffFreq).toBeCloseTo(0.24, 6);
  });
});

describe('removeBot', () => {
  it('is host-only, bots-only, and frees the seat with status left', () => {
    const t = new Table(2);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    expectError(t.tryApply({ type: 'removeBot', byId: 'p1', playerId: botId }), 'not-host');
    expectError(t.tryApply({ type: 'removeBot', byId: 'p0', playerId: 'p1' }), 'unknown-player');
    expectError(t.tryApply({ type: 'removeBot', byId: 'p0', playerId: 'ghost' }), 'unknown-player');
    t.apply({ type: 'removeBot', byId: 'p0', playerId: botId });
    expect(t.state.players[botId].status).toBe('left');
    expect(t.state.players[botId].seat).toBeNull();
    expect(t.state.seats[2]).toBeNull();
  });
});

describe('imBack', () => {
  it('requires a known player', () => {
    const t = new Table(2);
    expectError(t.tryApply({ type: 'imBack', playerId: 'ghost' }), 'unknown-player');
  });

  it('from a seated player is silent: no event, no clock change, actions emit no player-back', () => {
    const t = new Table(3);
    t.start();
    const d0 = t.hand.round.actionDeadline!;
    t.now += 5000;
    const res = t.tryApply({ type: 'imBack', playerId: 'p2' });
    expect(okEvents(res)).toEqual([]);
    expect(t.hand.round.actionDeadline).toBe(d0);
    const res2 = t.tryApply({ type: 'imBack', playerId: 'p1' }); // the acting player
    expect(okEvents(res2)).toEqual([]);
    expect(t.hand.round.actionDeadline).toBe(d0);
    const res3 = t.tryAct('p1', 'check');
    expect(types(okEvents(res3))).toEqual(['action', 'turn']); // no spurious player-back
  });

  it('still works after the host ended the game mid-hand (no hand object left)', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p1 away
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.hand).toBeNull();
    t.apply({ type: 'imBack', playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
  });
});

describe('away players', () => {
  it('on the clock get an instant deadline; imBack grants a fresh clock', () => {
    const t = awayP1OnTurn();
    expect(t.hand.round.actionDeadline).toBe(t.now);
    expect(t.hand.round.timeBankArmed).toBe(true);
    expect(t.hand.round.botActAt).toBeNull();
    const res = t.tryApply({ type: 'imBack', playerId: 'p1' });
    const evs = okEvents(res);
    expect(types(evs)).toEqual(['player-back']);
    expect(data(evs[0])).toEqual({ playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
    expect(t.hand.round.actionDeadline).toBe(t.now + 20_000);
    expect(t.hand.round.timeBankArmed).toBe(false);
  });

  it('returning off-turn leaves the acting clock alone', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p1 auto-checked + away; p2 now acts
    expect(t.toAct).toBe('p2');
    const d0 = t.hand.round.actionDeadline!;
    t.now += 3000;
    const res = t.tryApply({ type: 'imBack', playerId: 'p1' });
    expect(types(okEvents(res))).toEqual(['player-back']);
    expect(t.hand.round.actionDeadline).toBe(d0);
  });

  it('acting on their own restores them with a player-back event', () => {
    const t = awayP1OnTurn();
    const res = t.tryAct('p1', 'check');
    const evs = okEvents(res);
    expect(types(evs)[0]).toBe('player-back');
    expect(data(evs[0])).toEqual({ playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
    expect(t.hand.round.street).toBe('flop');
  });

  it('timing out again resolves the turn without a duplicate player-away', () => {
    const t = awayP1OnTurn();
    expect(eventsOf(t.state, 'player-away')).toHaveLength(1);
    t.apply({ type: 'timeout' }); // instant deadline already due
    expect(eventsOf(t.state, 'player-away')).toHaveLength(1);
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.hand.folded).not.toContain('p1'); // the check was free
    expect(t.hand.round.street).toBe('flop');
  });
});

describe('bot turns and timeouts', () => {
  it('stamps botActAt with jitter plus a fallback deadline; bot timeouts never mark it away', () => {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
    t.start();
    // Bot (left of the button) opens: bot stamp, fallback deadline.
    expect(t.toAct).toBe(botId);
    expect(t.hand.round.botActAt).toBe(t.now + 800); // zeroRand: no jitter
    expect(t.hand.round.actionDeadline).toBe(t.now + 800 + 10_000);
    t.act(botId, 'check');
    // Human turn: standard clock, no bot stamp.
    expect(t.toAct).toBe('p0');
    expect(t.hand.round.botActAt).toBeNull();
    expect(t.hand.round.actionDeadline).toBe(t.now + 20_000);
    t.randInt = () => 7;
    t.act('p0', 'check'); // closes preflop; flop turn goes to the bot
    expect(t.hand.round.street).toBe('flop');
    expect(t.toAct).toBe(botId);
    expect(t.hand.round.botActAt).toBe(t.now + 800 + 7);
    expect(t.hand.round.actionDeadline).toBe(t.now + 800 + 7 + 10_000);
    t.now = t.hand.round.actionDeadline!;
    t.apply({ type: 'timeout' }); // fallback: bot auto-checks, never goes away
    expect(t.state.players[botId].status).toBe('seated');
    expect(eventsOf(t.state, 'player-away')).toHaveLength(0);
    expect(t.toAct).toBe('p0');
    expect(t.hand.round.street).toBe('flop');
  });

  it('a busted bot schedules its auto-rebuy think delay from the RNG', () => {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
    t.start();
    t.rig({ p0: ['As', 'Ah'], [botId]: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act(botId, 'check');
    t.act('p0', 'bet', 19); // all-in over the ante
    t.randInt = () => 5;
    t.act(botId, 'call');
    expect(t.state.players[botId].status).toBe('busted');
    expect(t.state.players[botId].topUpAt).toBe(t.now + 800 + 5);
  });
});

describe('topUp', () => {
  it('emits topped-up with the amount and remaining count', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);
    t.topUp('p1');
    const ev = eventsOf(t.state, 'topped-up')[0];
    expect(data(ev)).toEqual({ playerId: 'p1', amount: 12, remaining: 1 });
  });

  it('with an exhausted schedule is illegal even while the game continues', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.state.players['p2'].topUpsUsed = 2;
    t.start(); // antes: p2 has 3 behind
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'check');
    t.act('p2', 'bet', 3); // all-in
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.players['p2'].status).toBe('busted');
    expect(t.state.phase).toBe('hand-over');
    expectError(t.tryTopUp('p2'), 'illegal-move');
  });

  it('a mid-hand rebuy never schedules a next hand', () => {
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
    expect(t.state.players['p2'].status).toBe('busted');
    t.nextHand(); // p0 vs p1 play on
    expect(t.state.phase).toBe('playing');
    t.topUp('p2');
    expect(t.state.phase).toBe('playing');
    expect(t.state.nextHandAt).toBeNull();
  });
});

describe('rebuy window accounting', () => {
  it('a pending (unseated) requester does not count as a live player', () => {
    const t = new Table(2);
    t.start();
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Px', seat: 2 });
    bustP1HeadsUp(t);
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.nextHandAt).toBe(t.now + 20_000);
    const win = eventsOf(t.state, 'top-up-window')[0];
    expect(data(win).until).toBe(t.state.nextHandAt);
    expect(data(win).playerIds).toEqual(['p1']);
  });

  it('the last chipped player leaving mid-window ends the game with no winner', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);
    t.apply({ type: 'leave', playerId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('lastPlayer');
    const ended = eventsOf(t.state, 'game-ended').at(-1)!;
    expect(data(ended).winnerId).toBeNull();
  });
});

describe('busting bookkeeping', () => {
  it('an already-busted spectator is not re-busted at later hand ends', () => {
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
    const bustedEvents = () =>
      eventsOf(t.state, 'player-busted').filter((e) => data(e).playerId === 'p2');
    expect(t.state.players['p2'].status).toBe('busted');
    expect(bustedEvents()).toHaveLength(1);
    t.nextHand();
    t.foldAround();
    expect(bustedEvents()).toHaveLength(1);
  });
});

describe('full-hand event stream', () => {
  it('one bet-and-showdown hand emits the exact sequence with load-bearing payloads', () => {
    const t = new Table(3);
    const seq0 = t.state.eventSeq;
    t.start();
    expect(t.hand.folded).toEqual([]);
    expect(t.hand.allIn).toEqual([]);
    expect(t.hand.round.actedSinceFullRaise).toEqual([]);
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.hand.round.actedSinceFullRaise).toEqual([]);
    t.act('p1', 'bet', 2);
    t.act('p2', 'call');
    t.act('p0', 'call');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');

    const evs = t.state.events.filter((e) => e.seq > seq0);
    expect(types(evs)).toEqual([
      'hand-started', 'antes-posted', 'turn',
      'action', 'turn', 'action', 'turn', 'action', 'street-dealt', 'turn',
      'action', 'turn', 'action', 'turn', 'action', 'street-dealt', 'turn',
      'action', 'turn', 'action', 'turn', 'action', 'street-dealt', 'turn',
      'action', 'turn', 'action', 'turn', 'action', 'hand-result',
    ]);
    expect(data(evs[0])).toMatchObject({
      handNo: 1, variant: 'holdem', buttonSeat: 0, inHand: ['p1', 'p2', 'p0'],
    });
    expect(data(evs[1])).toEqual({ amount: 1, playerIds: ['p1', 'p2', 'p0'], potTotal: 3 });
    expect(data(evs[2])).toMatchObject({ playerId: 'p1', street: 'preflop', deadline: NOW + 20_000 });
    expect(data(evs[3])).toMatchObject({
      playerId: 'p1', move: 'check', amount: 0, street: 'preflop', auto: false,
    });
    expect(data(evs[8]).street).toBe('flop');
    expect(data(evs[8]).cards).toHaveLength(3);
    expect(data(evs[8]).board).toHaveLength(3);
    expect(data(evs[10])).toMatchObject({ playerId: 'p1', move: 'bet', amount: 2, street: 'flop' });
    expect(data(evs[15]).street).toBe('turn');
    expect(data(evs[15]).cards).toHaveLength(1);
    expect(data(evs[15]).board).toHaveLength(4);
    expect(data(evs[22]).street).toBe('river');
    expect(data(evs[22]).board).toHaveLength(5);
    expect(data(evs[29])).toMatchObject({ handNo: 1, kind: 'showdown' });
    expect(data(evs[29]).board).toHaveLength(5);
    const pots = data(evs[29]).pots as { amount: number }[];
    expect(pots[0].amount).toBe(9); // 3 antes + 3×2 on the flop

    // Nobody busted; the showdown pause is exactly 5s with no rebuy window.
    expect(types(evs)).not.toContain('player-busted');
    expect(types(evs)).not.toContain('top-up-window');
    expect(t.state.nextHandAt).toBe(t.now + 5000);
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.state.players[id].status).toBe('seated');
    }
  });
});
