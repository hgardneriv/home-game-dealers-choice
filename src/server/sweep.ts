import type { Action, GameState } from '@/engine/types';
import { decideForBot } from '@/engine/bot';

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
