import { describe, expect, it } from 'vitest';
import { Table, expectError, NOW } from './test-utils';
import { dueSweepAction } from '../server/sweep';

/**
 * Scenario tests for the top-up (rebuy) flow: the re-entry hold window that
 * keeps a game-deciding bust from ending the game instantly, the topUp action
 * itself, bot auto-rebuys via the sweep, and every interaction with
 * leave/pause/expiry that the design called out.
 */

/** Heads-up all-in where p1 loses their whole stack to p0. */
function bustP1HeadsUp(t: Table): void {
  // Button is seat 0 with zeroRand; the non-button p1 opens every street.
  // Bet amounts are "to" street totals; antes never touch round.committed,
  // so an all-in shove is stack + already-committed street chips.
  t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  t.act('p1', 'bet', t.stack('p1') + (t.hand.round.committed['p1'] ?? 0));
  t.act('p0', 'call');
  // Both all-in: streets run out automatically to showdown.
  expect(t.state.players['p1'].status).toBe('busted');
}

describe('re-entry hold window', () => {
  it('a game-deciding bust holds the table open instead of ending', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);

    expect(t.state.phase).toBe('hand-over');
    expect(t.state.nextHandAt).toBe(t.now + 20_000);
    const types = t.state.events.map((e) => e.type);
    expect(types).toContain('player-busted');
    expect(types).toContain('top-up-window');
  });

  it('topping up in the window revives the game and shortens the wait', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);

    t.now += 2_000;
    t.topUp('p1');
    const p1 = t.state.players['p1'];
    expect(p1.stack).toBe(12); // 60% of the $20 buy-in
    expect(p1.status).toBe('seated');
    expect(p1.totalBuyIn).toBe(32);
    expect(p1.topUpsUsed).toBe(1);
    // Don't make the winner sit out the rest of the 20s window.
    expect(t.state.nextHandAt).toBe(t.now + 5_000);

    // Dealt straight into the next hand.
    t.nextHand();
    expect(t.state.phase).toBe('playing');
    expect(t.hand.inHand).toContain('p1');
    expect(t.hand.inHand).toContain('p0');
  });

  it('topUps: 0 preserves the old instant game-over', () => {
    const t = new Table(2, { config: { topUps: 0 } });
    t.start();
    t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act('p1', 'bet', 19); // all-in over the ante
    t.act('p0', 'call');
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('lastPlayer');
  });

  it('an expired window settles to game over with the right winner', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);

    t.nextHand(); // clock jumps past the window; <2 eligible → endGame
    expect(t.state.phase).toBe('ended');
    const ended = t.state.events.find((e) => e.type === 'game-ended');
    expect((ended!.data as { winnerId: string }).winnerId).toBe('p0');
  });

  it('a late topUp after the window expired is rejected', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);
    t.nextHand();
    expectError(t.tryTopUp('p1'), 'bad-phase');
  });
});

describe('topUp validation', () => {
  it('rejects players who still have chips, strangers, and lobby-phase calls', () => {
    const t = new Table(2);
    expectError(t.tryTopUp('p0'), 'bad-phase'); // lobby
    t.start();
    expectError(t.tryTopUp('p0'), 'illegal-move'); // has chips
    expectError(t.tryTopUp('ghost'), 'unknown-player');
  });

  it('rejects once the schedule is exhausted', () => {
    const t = new Table(2);
    t.start();
    for (let rebuy = 0; rebuy < 2; rebuy++) {
      // p1's stack varies per cycle; whoever opens shoves whatever they have.
      t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
      const first = t.toAct!;
      const other = first === 'p0' ? 'p1' : 'p0';
      t.act(first, 'bet', t.stack(first) + (t.hand.round.committed[first] ?? 0));
      t.act(other, 'call');
      expect(t.state.players['p1'].status).toBe('busted');
      t.topUp('p1');
      t.nextHand();
    }
    // Third bust: no top-ups left → game just ends.
    t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    const first = t.toAct!;
    const other = first === 'p0' ? 'p1' : 'p0';
    t.act(first, 'bet', t.stack(first) + (t.hand.round.committed[first] ?? 0));
    t.act(other, 'call');
    expect(t.state.phase).toBe('ended');
    expectError(t.tryTopUp('p1'), 'bad-phase');
    expect(t.state.players['p1'].topUpsUsed).toBe(2);
    expect(t.state.players['p1'].totalBuyIn).toBe(20 + 12 + 6);
  });

  it('a busted spectator can top up mid-hand without touching the live hand', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.start(); // button 0, order p1, p2, p0; antes leave p2 with 3
    t.rig({ p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act('p1', 'check');
    t.act('p2', 'bet', 3); // all-in
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.players['p2'].status).toBe('busted');
    expect(t.state.phase).toBe('hand-over'); // 2 chipped → normal hand-over

    t.nextHand(); // p0 and p1 play on without p2
    expect(t.hand.inHand).not.toContain('p2');
    const handNo = t.hand.handNo;
    const toActBefore = t.toAct;

    t.topUp('p2'); // mid-hand rebuy
    expect(t.state.phase).toBe('playing');
    expect(t.hand.handNo).toBe(handNo);
    expect(t.toAct).toBe(toActBefore);
    expect(t.hand.inHand).not.toContain('p2');

    t.foldAround();
    t.nextHand();
    expect(t.hand.inHand).toContain('p2'); // dealt into the following hand
  });
});

describe('multi-bust and leave interactions', () => {
  /** 3-handed all-in that busts p1 and p2, leaving p0 with everything. */
  function bustTwo(t: Table): void {
    t.rig({ p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act('p1', 'bet', 19); // all-in over the ante
    t.act('p2', 'call');
    t.act('p0', 'call');
    expect(t.state.players['p1'].status).toBe('busted');
    expect(t.state.players['p2'].status).toBe('busted');
  }

  it('two simultaneous busts hold one window; either can revive the game', () => {
    const t = new Table(3);
    t.start();
    bustTwo(t);
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.nextHandAt).toBe(t.now + 20_000);

    t.topUp('p1');
    expect(t.state.nextHandAt).toBe(t.now + 5_000);
    t.nextHand();
    expect(t.hand.inHand).toEqual(expect.arrayContaining(['p0', 'p1']));
    expect(t.hand.inHand).not.toContain('p2');
  });

  it('a rebuyer leaving during the window settles the game immediately', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);
    t.apply({ type: 'leave', playerId: 'p1' });
    expect(t.state.phase).toBe('ended');
    const ended = t.state.events.find((e) => e.type === 'game-ended');
    expect((ended!.data as { winnerId: string }).winnerId).toBe('p0');
  });

  it('the last chipped opponent leaving opens a window for a seated rebuyer', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.start();
    t.rig({ p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act('p1', 'check');
    t.act('p2', 'bet', 3);
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over'); // p0 + p1 chipped, p2 busted

    t.apply({ type: 'leave', playerId: 'p1' }); // now only p0 chipped
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.nextHandAt).toBeGreaterThanOrEqual(t.now + 20_000);
    expect(t.state.events.map((e) => e.type)).toContain('top-up-window');
  });

  it('pause-after-hand yields to the hold window but sticks around', () => {
    const t = new Table(2);
    t.start();
    t.apply({ type: 'pause', byId: 'p0' }); // mid-hand → pauseAfterHand
    expect(t.state.pauseAfterHand).toBe(true);
    bustP1HeadsUp(t);
    expect(t.state.phase).toBe('hand-over'); // window wins over pause
    expect(t.state.pauseAfterHand).toBe(true);
  });
});

describe('bot auto-top-up via the sweep', () => {
  function tableWithBot(): { t: Table; botId: string } {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
    t.start();
    return { t, botId };
  }

  it('stamps a think-delay deadline when a bot busts with a rebuy left', () => {
    const { t, botId } = tableWithBot();
    t.rig({ p0: ['As', 'Ah'], [botId]: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act(botId, 'check'); // the bot (non-button) opens
    t.act('p0', 'bet', 19);
    t.act(botId, 'call');
    const bot = t.state.players[botId];
    expect(bot.status).toBe('busted');
    // zeroRand → exactly base delay (800ms), inside the jitter envelope.
    expect(bot.topUpAt).toBe(t.now + 800);

    // Not due yet → the sweep has nothing; due → it returns the topUp,
    // and when nextHand is also due the rebuy still goes first.
    expect(dueSweepAction(t.state, bot.topUpAt! - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, bot.topUpAt!, t.randInt)).toEqual({
      type: 'topUp',
      playerId: botId,
    });
    expect(dueSweepAction(t.state, t.state.nextHandAt! + 1, t.randInt)).toEqual({
      type: 'topUp',
      playerId: botId,
    });

    t.now = bot.topUpAt!;
    t.topUp(botId);
    expect(t.state.players[botId].topUpAt).toBeNull();
    expect(t.state.players[botId].stack).toBe(12);
    // With the bot revived, the sweep's next due action is the deal itself.
    expect(dueSweepAction(t.state, t.state.nextHandAt! + 1, t.randInt)).toEqual({
      type: 'nextHand',
    });
  });

  it('an exhausted bot gets no deadline and the sweep leaves it alone', () => {
    const { t, botId } = tableWithBot();
    t.state.players[botId].topUpsUsed = 2; // schedule spent
    t.rig({ p0: ['As', 'Ah'], [botId]: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act(botId, 'check');
    t.act('p0', 'bet', 19);
    t.act(botId, 'call');
    expect(t.state.phase).toBe('ended'); // nobody can rebuy → instant game over
    expect(t.state.players[botId].topUpAt).toBeNull();
  });
});

describe('chip conservation with top-ups', () => {
  it('total chips always equal the sum of every buy-in', () => {
    const t = new Table(2);
    t.start();
    bustP1HeadsUp(t);
    t.topUp('p1');
    const totalBuyIns = Object.values(t.state.players).reduce((a, p) => a + p.totalBuyIn, 0);
    expect(totalBuyIns).toBe(20 + 20 + 12);
    expect(t.totalChips()).toBe(totalBuyIns);
    expect(t.now).toBeGreaterThanOrEqual(NOW);
  });
});
