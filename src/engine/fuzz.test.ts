import { describe, expect, it } from 'vitest';
import { applyAction, createGame } from './engine';
import { getLegalActions } from './betting';
import { decideForBot } from './bot';
import { seededRandInt } from './test-utils';
import type { EngineCtx, GameState, PlayerMove } from './types';

/**
 * Fuzz harness: plays complete games with a mix of bot-brain actors and
 * random-legal actors, simulating the server sweep (timeouts, bot turns,
 * next-hand ticks). Invariants are checked after every single action:
 *   - chips are conserved (stacks + live pot == constant)
 *   - no negative stacks or bets
 *   - every hand terminates
 */

function totalChips(state: GameState): number {
  const stacks = Object.values(state.players).reduce((a, p) => a + p.stack, 0);
  const pot = state.hand
    ? Object.values(state.hand.totalCommitted).reduce((a, b) => a + b, 0)
    : 0;
  // After a result, payouts are already back in stacks.
  return state.hand && !state.hand.result ? stacks + pot : stacks;
}

function checkInvariants(state: GameState, expectedTotal: number): void {
  expect(totalChips(state)).toBe(expectedTotal);
  for (const p of Object.values(state.players)) {
    expect(p.stack).toBeGreaterThanOrEqual(0);
  }
  if (state.hand && !state.hand.result) {
    const r = state.hand.round;
    for (const v of Object.values(r.committed)) expect(v).toBeGreaterThanOrEqual(0);
    if (r.toAct) {
      expect(state.hand.folded).not.toContain(r.toAct);
      expect(state.hand.allIn).not.toContain(r.toAct);
    }
  }
}

function randomLegalMove(
  state: GameState,
  playerId: string,
  randInt: (n: number) => number
): { move: PlayerMove; amount?: number } {
  const legal = getLegalActions(state, playerId)!;
  const options: { move: PlayerMove; amount?: number }[] = [];
  if (legal.canCheck) options.push({ move: 'check' }, { move: 'check' });
  if (legal.callAmount > 0) options.push({ move: 'call' }, { move: 'call' });
  options.push({ move: 'fold' });
  if (legal.canBet || legal.canRaise) {
    const span = legal.maxRaiseTo - legal.minRaiseTo;
    const amount =
      span > 0 ? legal.minRaiseTo + randInt(span + 1) : legal.minRaiseTo;
    options.push({ move: legal.canBet ? 'bet' : 'raise', amount });
    // All-ins are the spiciest edge case — overweight them.
    options.push({ move: legal.canBet ? 'bet' : 'raise', amount: legal.maxRaiseTo });
  }
  return options[randInt(options.length)];
}

function playGame(seed: number, numPlayers: number, botMask: number): number {
  const randInt = seededRandInt(seed);
  let now = 1_000_000;
  const ctx = (): EngineCtx => ({ now, randInt });

  let state = createGame({
    id: `fuzz${seed}`,
    hostId: 'p0',
    hostName: 'P0',
    config: { startingStack: 20 + randInt(30) },
    now,
  });
  for (let i = 1; i < numPlayers; i++) {
    const join = applyAction(
      state,
      { type: 'requestSeat', playerId: `p${i}`, name: `P${i}`, seat: i },
      ctx()
    );
    if (!join.ok) throw new Error(join.error.message);
    state = join.state;
    const approve = applyAction(
      state,
      { type: 'approveSeat', byId: 'p0', playerId: `p${i}` },
      ctx()
    );
    if (!approve.ok) throw new Error(approve.error.message);
    state = approve.state;
  }
  const expectedTotal = numPlayers * state.config.startingStack;

  const started = applyAction(state, { type: 'startGame', byId: 'p0' }, ctx());
  if (!started.ok) throw new Error(started.error.message);
  state = started.state;

  let handsPlayed = 0;
  let steps = 0;
  while (state.phase !== 'ended') {
    if (++steps > 20_000) throw new Error(`game did not terminate (seed ${seed})`);
    checkInvariants(state, expectedTotal);

    if (state.phase === 'hand-over') {
      now = (state.nextHandAt ?? now) + 1;
      const res = applyAction(state, { type: 'nextHand' }, ctx());
      if (!res.ok) throw new Error(`nextHand failed: ${res.error.message}`);
      state = res.state;
      handsPlayed++;
      if (handsPlayed > 2_000) throw new Error(`too many hands (seed ${seed})`);
      continue;
    }

    if (state.phase !== 'playing' || !state.hand) {
      throw new Error(`unexpected phase ${state.phase} (seed ${seed})`);
    }

    const acting = state.hand.round.toAct;
    if (!acting) throw new Error(`playing with no one to act (seed ${seed})`);

    // Advance the clock a little each step, like real time passing.
    now += 100 + randInt(400);

    const actorIndex = Number(acting.slice(1));
    const useBotBrain = (botMask >> actorIndex) & 1;
    const decision = useBotBrain
      ? decideForBot(state, acting, randInt)!
      : randomLegalMove(state, acting, randInt);

    // Occasionally let the timer fire instead of acting.
    if (randInt(20) === 0) {
      now = (state.hand.round.actionDeadline ?? now) + 1;
      const res = applyAction(state, { type: 'timeout' }, ctx());
      if (!res.ok) throw new Error(`timeout failed: ${res.error.message}`);
      state = res.state;
      continue;
    }

    const res = applyAction(
      state,
      { type: 'playerAction', playerId: acting, move: decision.move, amount: decision.amount },
      ctx()
    );
    if (!res.ok) {
      throw new Error(
        `illegal action by ${acting} (${decision.move} ${decision.amount ?? ''}) ` +
          `seed ${seed}: ${res.error.message}`
      );
    }
    state = res.state;
  }
  checkInvariants(state, expectedTotal);
  return handsPlayed;
}

describe('fuzz: complete games with invariants', () => {
  it('plays 150 seeded games (mixed bot + random actors) without violations', () => {
    let totalHands = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const numPlayers = 2 + (seed % 5); // 2..6 players
      const botMask = seed * 7; // arbitrary mix of bot/random actors per seat
      totalHands += playGame(seed, numPlayers, botMask);
    }
    // Sanity: the fuzz actually exercised a meaningful number of hands.
    expect(totalHands).toBeGreaterThan(500);
  }, 120_000);
});
