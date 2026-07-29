import type { Action, GameState } from '@/engine/types';
import { decideForBot } from '@/engine/bot';
import { topUpAmount } from '@/engine/topup';

/** Humans get a moment of slack past the visible deadline before auto-action. */
const TIMEOUT_GRACE_MS = 1000;

/**
 * The heart of serverless timing: given the current state and wall clock,
 * return the next server-generated action that is due, or null. Every state
 * read runs this (and persists the result), so timers and bot turns fire
 * within one client poll tick of their deadline — no background process.
 */
export function dueSweepAction(
  state: GameState,
  now: number,
  randInt: (n: number) => number
): Action | null {
  // Busted bots rebuy automatically once their "think" delay passes. Checked
  // before nextHand so a due bot is dealt into the hand that deal starts.
  // Re-validated here (not just topUpAt) because a rejected due-action would
  // break the sweep loop in withGame and stall the game permanently.
  if (state.phase === 'playing' || state.phase === 'hand-over' || state.phase === 'paused') {
    for (const p of Object.values(state.players)) {
      if (
        p.isBot &&
        p.status === 'busted' &&
        p.topUpAt != null &&
        now >= p.topUpAt &&
        topUpAmount(state.config, p.topUpsUsed ?? 0) > 0
      ) {
        return { type: 'topUp', playerId: p.id };
      }
    }
  }

  if (state.phase === 'playing' && state.hand) {
    const round = state.hand.round;
    const acting = round.toAct ? state.players[round.toAct] : null;

    if (acting?.isBot && round.botActAt !== null && now >= round.botActAt) {
      const decision = decideForBot(state, acting.id, randInt);
      if (decision) {
        return {
          type: 'playerAction',
          playerId: acting.id,
          move: decision.move,
          amount: decision.amount,
        };
      }
      // Bot brain failed — fall through to the timeout backstop.
    }

    if (acting && round.actionDeadline !== null) {
      const grace = acting.isBot ? 0 : TIMEOUT_GRACE_MS;
      if (now >= round.actionDeadline + grace) return { type: 'timeout' };
    }
    return null;
  }

  if (state.phase === 'hand-over' && state.nextHandAt !== null && now >= state.nextHandAt) {
    return { type: 'nextHand' };
  }

  return null;
}
