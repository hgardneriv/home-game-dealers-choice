import { describe, expect, it } from 'vitest';
import { Table, REBUY_CONFIG } from '@/engine/test-utils';
import type { GameState, Player } from '@/engine/types';
import { dueSweepAction } from './sweep';

/**
 * Boundary/guard tests for dueSweepAction — the serverless timing heart.
 * Complements src/engine/topup-flow.test.ts (which covers the happy-path bot
 * rebuy timing); here we pin phase gating, the re-validation guards, exact
 * >=-vs-> deadline boundaries, and the human/bot TIMEOUT_GRACE split.
 *
 * dueSweepAction is pure, so states are built with the engine harness and
 * then surgically mutated to reach the guard branches.
 */

/** Heads-up human table, mid-hand: p1 (left of button p0) to act, no bot deadlines. */
function playingHumans(): Table {
  const t = new Table(2);
  t.start();
  expect(t.state.phase).toBe('playing');
  expect(t.toAct).toBe('p1');
  return t;
}

/** Two humans, hand just ended by a fold: phase hand-over with nextHandAt set. */
function humanHandOver(): Table {
  const t = new Table(2);
  t.start();
  t.act('p1', 'fold');
  expect(t.state.phase).toBe('hand-over');
  expect(t.state.nextHandAt).not.toBeNull();
  return t;
}

/** Host + bot, mid-hand with the BOT to act (botActAt stamped at the deal). */
function botToAct(): { t: Table; botId: string } {
  const t = new Table(1);
  t.apply({ type: 'addBot', byId: 'p0' });
  const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
  t.start(); // bot sits left of the button (seat 1) and acts first
  expect(t.toAct).toBe(botId);
  expect(t.hand.round.botActAt).not.toBeNull();
  return { t, botId };
}

/** Host + bot; the bot busts, opening the top-up window (topUpAt stamped). */
function bustedBotHandOver(): { t: Table; botId: string } {
  const t = new Table(1, { config: REBUY_CONFIG });
  t.apply({ type: 'addBot', byId: 'p0' });
  const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
  t.start();
  t.rig({ p0: ['As', 'Ah'], [botId]: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  t.act(botId, 'check');
  t.act('p0', 'bet', 19); // post-ante stacks are 19 — an all-in open
  t.act(botId, 'call');
  expect(t.state.phase).toBe('hand-over');
  expect(t.state.players[botId].status).toBe('busted');
  expect(t.state.players[botId].topUpAt).not.toBeNull();
  return { t, botId };
}

function inPhase(state: GameState, phase: GameState['phase']): GameState {
  const clone = structuredClone(state);
  clone.phase = phase;
  return clone;
}

describe('bot top-up: phase gating', () => {
  it('fires in hand-over, and beats a due nextHand', () => {
    const { t, botId } = bustedBotHandOver();
    const due = t.state.players[botId].topUpAt!;
    expect(dueSweepAction(t.state, due, t.randInt)).toEqual({ type: 'topUp', playerId: botId });
    expect(dueSweepAction(t.state, t.state.nextHandAt! + 1, t.randInt)).toEqual({
      type: 'topUp',
      playerId: botId,
    });
  });

  it('fires in paused', () => {
    const { t, botId } = bustedBotHandOver();
    const paused = inPhase(t.state, 'paused');
    paused.nextHandAt = null;
    expect(dueSweepAction(paused, t.state.players[botId].topUpAt!, t.randInt)).toEqual({
      type: 'topUp',
      playerId: botId,
    });
  });

  it('fires in playing (busted spectator bot), before any timeout backstop', () => {
    const t = new Table(2, { config: REBUY_CONFIG });
    t.start();
    t.state.players.b9 = {
      id: 'b9',
      name: 'Bot 9',
      seat: null,
      stack: 0,
      status: 'busted',
      timeBankMs: 0,
      isHost: false,
      isBot: true,
      lastSeenAt: t.now,
      totalBuyIn: 20,
      topUpsUsed: 0,
      topUpAt: t.now - 1,
    } as Player;
    // Even with the acting human's deadline long blown, the rebuy goes first.
    t.hand.round.actionDeadline = t.now - 60_000;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toEqual({ type: 'topUp', playerId: 'b9' });
  });

  it('never fires in ended or lobby, even with a due topUpAt on the books', () => {
    const { t, botId } = bustedBotHandOver();
    const now = t.state.nextHandAt! + 1;
    for (const phase of ['ended', 'lobby'] as const) {
      const s = inPhase(t.state, phase);
      s.nextHandAt = null;
      expect(dueSweepAction(s, now, t.randInt)).toBeNull();
      expect(s.players[botId].topUpAt).not.toBeNull(); // guard really was the phase
    }
  });
});

describe('bot top-up: re-validation guards', () => {
  it('ignores a busted HUMAN even with a due topUpAt', () => {
    const t = humanHandOver();
    t.state.players.p1.status = 'busted';
    t.state.players.p1.topUpAt = t.now - 1;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toBeNull();
  });

  it('ignores a non-busted bot with a stale topUpAt', () => {
    const t = new Table(1);
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
    t.start();
    t.act(botId, 'fold'); // hand-over, bot still seated with chips
    expect(t.state.phase).toBe('hand-over');
    t.state.players[botId].topUpAt = t.now - 1;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toBeNull();
  });

  it('ignores a busted bot whose topUpAt is null', () => {
    const { t, botId } = bustedBotHandOver();
    t.state.players[botId].topUpAt = null;
    expect(dueSweepAction(t.state, t.state.nextHandAt! - 1, t.randInt)).toBeNull();
  });

  it('ignores a busted bot whose top-up schedule is exhausted', () => {
    const { t, botId } = bustedBotHandOver();
    const due = t.state.players[botId].topUpAt!;
    t.state.players[botId].topUpsUsed = t.state.config.topUps; // spent
    expect(dueSweepAction(t.state, due, t.randInt)).toBeNull();
  });
});

describe('bot turns: botActAt boundary', () => {
  it('acts exactly at botActAt (>=, not >)', () => {
    const { t, botId } = botToAct();
    const due = t.hand.round.botActAt!;
    const action = dueSweepAction(t.state, due, t.randInt);
    expect(action).toMatchObject({ type: 'playerAction', playerId: botId });
    expect((action as { move?: string }).move).toBeTruthy();
  });

  it('does nothing one tick before botActAt', () => {
    const { t } = botToAct();
    expect(dueSweepAction(t.state, t.hand.round.botActAt! - 1, t.randInt)).toBeNull();
  });

  it('does not decide for a bot when botActAt is null', () => {
    const { t } = botToAct();
    t.hand.round.botActAt = null;
    t.hand.round.actionDeadline = t.now + 60_000;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toBeNull();
  });

  it('never decides for a HUMAN, even with a stale due botActAt on the round', () => {
    const t = playingHumans();
    t.hand.round.botActAt = t.now - 1;
    t.hand.round.actionDeadline = t.now + 60_000;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toBeNull();
  });

  it('human acting, no botActAt, deadline far out: nothing due', () => {
    const t = playingHumans();
    t.hand.round.actionDeadline = t.now + 60_000;
    expect(dueSweepAction(t.state, t.now + 30_000, t.randInt)).toBeNull();
  });

  it('no actor (toAct null): nothing due, even with an expired deadline', () => {
    const t = playingHumans();
    t.hand.round.toAct = null;
    t.hand.round.actionDeadline = t.now - 5_000;
    expect(dueSweepAction(t.state, t.now, t.randInt)).toBeNull();
  });
});

describe('timeout grace boundaries', () => {
  it('human: fires exactly at deadline + 1000ms, not at +999ms', () => {
    const t = playingHumans();
    const deadline = t.hand.round.actionDeadline!;
    expect(dueSweepAction(t.state, deadline + 999, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline + 1000, t.randInt)).toEqual({ type: 'timeout' });
  });

  it('bot: zero grace — fires exactly at the deadline', () => {
    const { t } = botToAct();
    t.hand.round.botActAt = null; // knock out the decision branch; timeout is the backstop
    const deadline = t.hand.round.actionDeadline!;
    expect(dueSweepAction(t.state, deadline - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline, t.randInt)).toEqual({ type: 'timeout' });
  });

  it('no deadline stamped: never times out', () => {
    const t = playingHumans();
    t.hand.round.actionDeadline = null;
    expect(dueSweepAction(t.state, t.now + 1_000_000, t.randInt)).toBeNull();
  });
});

describe('nextHand scheduling', () => {
  it('fires exactly at nextHandAt (>=, not >)', () => {
    const t = humanHandOver();
    const at = t.state.nextHandAt!;
    expect(dueSweepAction(t.state, at - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, at, t.randInt)).toEqual({ type: 'nextHand' });
  });

  it('does not fire without a schedule', () => {
    const t = humanHandOver();
    t.state.nextHandAt = null;
    expect(dueSweepAction(t.state, t.now + 1_000_000, t.randInt)).toBeNull();
  });

  it('does not fire outside hand-over, even with nextHandAt in the past', () => {
    const t = humanHandOver();
    const paused = inPhase(t.state, 'paused');
    expect(dueSweepAction(paused, t.state.nextHandAt! + 10, t.randInt)).toBeNull();
  });
});
