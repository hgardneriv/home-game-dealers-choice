import { describe, expect, it } from 'vitest';
import { applyAction, createGame } from './engine';
import { getLegalActions } from './betting';
import { decideExchangeForBot, decideForBot } from './bot';
import { topUpAmount } from './topup';
import { seededRandInt } from './test-utils';
import type { EngineCtx, GameState, PlayerMove, VariantId, VariantMoveInput } from './types';

/**
 * Fuzz harness: plays complete games with a mix of bot-brain actors and
 * random-legal actors, simulating the server sweep (timeouts, bot turns,
 * next-hand ticks) and random busted-player top-ups. Invariants are checked
 * after every single action:
 *   - chips are conserved (stacks + live pot == sum of all buy-ins)
 *   - buy-ins follow the top-up schedule exactly
 *   - no negative stacks or bets
 *   - every hand terminates
 * Ante-era edge worth knowing: an ante equal to a player's whole stack antes
 * them all-in, and a hand where EVERYONE is all-in from antes auto-runs to
 * showdown with no turns at all — both are correct and covered here.
 */

function totalChips(state: GameState): number {
  const stacks = Object.values(state.players).reduce((a, p) => a + p.stack, 0);
  const committed = state.hand
    ? Object.values(state.hand.totalCommitted).reduce((a, b) => a + b, 0)
    : 0;
  const communal = (state.hand?.pot ?? 0) + state.carryPot;
  // After a result, payouts are already back in stacks.
  return (state.hand && !state.hand.result ? stacks + committed : stacks) + communal;
}

/** Top-ups inject chips, so "constant total" is really "sum of all buy-ins". */
function expectedTotal(state: GameState): number {
  return Object.values(state.players).reduce((a, p) => a + p.totalBuyIn, 0);
}

function checkInvariants(state: GameState): void {
  expect(totalChips(state)).toBe(expectedTotal(state));
  for (const p of Object.values(state.players)) {
    expect(p.stack).toBeGreaterThanOrEqual(0);
    expect(p.topUpsUsed).toBeLessThanOrEqual(state.config.topUps);
    if (p.status === 'busted') expect(p.stack).toBe(0);
    // totalBuyIn must be exactly the starting stack plus the config schedule.
    let scheduled = state.config.startingStack;
    for (let k = 0; k < p.topUpsUsed; k++) scheduled += topUpAmount(state.config, k);
    expect(p.totalBuyIn).toBe(scheduled);
  }
  if (state.hand && !state.hand.result) {
    const r = state.hand.round;
    for (const v of Object.values(r.committed)) expect(v).toBeGreaterThanOrEqual(0);
    if (r.toAct && r.kind === 'betting') {
      expect(state.hand.folded).not.toContain(r.toAct);
      expect(state.hand.allIn).not.toContain(r.toAct);
    }
  }
}

/** A random legal draw: 0..3 distinct indexes out of a five-card hand. */
function randomDiscard(randInt: (n: number) => number): VariantMoveInput {
  const count = randInt(4);
  const pool = [0, 1, 2, 3, 4];
  const cardIndexes: number[] = [];
  for (let i = 0; i < count; i++) {
    cardIndexes.push(pool.splice(randInt(pool.length), 1)[0]);
  }
  return { kind: 'discard', cardIndexes };
}

function randomLegalMove(
  state: GameState,
  playerId: string,
  randInt: (n: number) => number
): { move: PlayerMove; amount?: number } {
  const legal = getLegalActions(state, playerId);
  if (!legal || legal.kind !== 'betting')
    throw new Error(`expected betting legal actions for ${playerId}`);
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

  const ante = 1 + randInt(3); // 1..3
  const variantMixes: VariantId[][] = [['holdem'], ['five-draw'], ['holdem', 'five-draw']];
  let state = createGame({
    id: `fuzz${seed}`,
    hostId: 'p0',
    hostName: 'P0',
    config: {
      startingStack: 20 + randInt(30),
      ante,
      minBet: ante + randInt(3 * ante + 1), // ante..4×ante
      enabledVariants: variantMixes[randInt(variantMixes.length)],
      topUps: randInt(4),
      topUpDecayPct: [0, 25, 50, 100][randInt(4)],
    },
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
  const started = applyAction(state, { type: 'startGame', byId: 'p0' }, ctx());
  if (!started.ok) throw new Error(started.error.message);
  state = started.state;

  // A busted player rebuys with probability 1/2 per hand-over tick — so both
  // the rebuy paths and the window-expiry endGame paths get exercised.
  const maybeTopUp = (): boolean => {
    const busted = Object.values(state.players).filter(
      (p) => p.seat !== null && p.status === 'busted'
    );
    for (const p of busted) {
      if (randInt(2) === 0) continue;
      const legal = topUpAmount(state.config, p.topUpsUsed) > 0;
      const res = applyAction(state, { type: 'topUp', playerId: p.id }, ctx());
      if (res.ok !== legal) {
        throw new Error(
          `topUp by ${p.id} (used ${p.topUpsUsed}) should ${legal ? 'succeed' : 'fail'} (seed ${seed})`
        );
      }
      if (res.ok) {
        state = res.state;
        return true;
      }
    }
    return false;
  };

  let handsPlayed = 0;
  let steps = 0;
  while (state.phase !== 'ended') {
    if (++steps > 30_000) throw new Error(`game did not terminate (seed ${seed})`);
    checkInvariants(state);

    if (state.phase === 'hand-over') {
      if (maybeTopUp()) continue;
      now = (state.nextHandAt ?? now) + 1;
      const res = applyAction(state, { type: 'nextHand' }, ctx());
      if (!res.ok) throw new Error(`nextHand failed: ${res.error.message}`);
      state = res.state;
      handsPlayed++;
      if (handsPlayed > 3_000) throw new Error(`too many hands (seed ${seed})`);
      continue;
    }

    // Dealer's choice: the dealer picks (occasionally the timer does instead).
    if (state.phase === 'choosing') {
      now += 100 + randInt(400);
      if (randInt(10) === 0) {
        now = state.choosing!.deadline + 1;
        const res = applyAction(state, { type: 'chooseTimeout' }, ctx());
        if (!res.ok) throw new Error(`chooseTimeout failed: ${res.error.message} (seed ${seed})`);
        state = res.state;
        continue;
      }
      const options = state.config.enabledVariants;
      const res = applyAction(
        state,
        {
          type: 'chooseGame',
          playerId: state.choosing!.dealerId,
          variant: options[randInt(options.length)],
        },
        ctx()
      );
      if (!res.ok) throw new Error(`chooseGame failed: ${res.error.message} (seed ${seed})`);
      state = res.state;
      continue;
    }

    if (state.phase !== 'playing' || !state.hand) {
      throw new Error(`unexpected phase ${state.phase} (seed ${seed})`);
    }

    const acting = state.hand.round.toAct;
    if (!acting) throw new Error(`playing with no one to act (seed ${seed})`);

    // Advance the clock a little each step, like real time passing.
    now += 100 + randInt(400);

    // Occasionally a busted spectator rebuys mid-hand — the live hand must
    // be unaffected (they join the next deal).
    if (randInt(15) === 0) {
      const handBefore = JSON.stringify(state.hand);
      if (maybeTopUp()) {
        expect(JSON.stringify(state.hand)).toBe(handBefore);
        continue;
      }
    }

    // Occasionally let the timer fire instead of acting (covers the
    // exchange-round auto-stand-pat path too).
    if (randInt(20) === 0) {
      now = (state.hand.round.actionDeadline ?? now) + 1;
      const res = applyAction(state, { type: 'timeout' }, ctx());
      if (!res.ok) throw new Error(`timeout failed: ${res.error.message}`);
      state = res.state;
      continue;
    }

    const actorIndex = Number(acting.slice(1));
    const useBotBrain = (botMask >> actorIndex) & 1;

    if (state.hand.round.kind === 'exchange') {
      const move: VariantMoveInput = useBotBrain
        ? (decideExchangeForBot(state, acting, randInt) ?? { kind: 'discard', cardIndexes: [] })
        : randomDiscard(randInt);
      const res = applyAction(state, { type: 'variantMove', playerId: acting, move }, ctx());
      if (!res.ok) {
        throw new Error(
          `illegal draw by ${acting} (${JSON.stringify(move)}) seed ${seed}: ${res.error.message}`
        );
      }
      state = res.state;
      continue;
    }

    const decision = useBotBrain
      ? // decideForBot only returns null off betting rounds — handled above.
        (decideForBot(state, acting, randInt) ?? randomLegalMove(state, acting, randInt))
      : randomLegalMove(state, acting, randInt);

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
  checkInvariants(state);
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
