'use client';

import { useSyncExternalStore } from 'react';
import { reviewingLastHand, type GamePhase } from '@/engine/types';

/** Last table this browser sat at. Identity stays the httpOnly cookie. */
export const LAST_GAME_KEY = 'hg:lastGameId';

function subscribe(onChange: () => void) {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}

export function readLastGameId(): string | null {
  try {
    return localStorage.getItem(LAST_GAME_KEY);
  } catch {
    return null;
  }
}

export function writeLastGameId(gameId: string): void {
  try {
    localStorage.setItem(LAST_GAME_KEY, gameId);
    window.dispatchEvent(new Event('storage'));
  } catch {
    // storage unavailable (private mode) — resume simply won't be offered
  }
}

export function clearLastGameId(): void {
  try {
    localStorage.removeItem(LAST_GAME_KEY);
    window.dispatchEvent(new Event('storage'));
  } catch {
    // ignore
  }
}

/** Server snapshot is null so hydration stays clean. */
export function useLastGameId(): string | null {
  return useSyncExternalStore(subscribe, readLastGameId, () => null);
}

export type TableMemory =
  | { action: 'write'; gameId: string }
  | { action: 'clear' }
  | { action: 'keep' };

/**
 * Remember the table while you are seated or waiting on a request.
 * Clear it when the table is gone, when you left or were kicked, or when
 * the standings are up — an ended night is not a table to return to.
 * The last hand still on the felt counts as in progress.
 * A spectator opening someone else's link does not clobber the saved id.
 */
export function rememberedTableAction(
  gameId: string,
  input: {
    error: boolean;
    state: {
      phase: GamePhase;
      resultsShown?: boolean;
      hand: { result: unknown } | null;
      yourId: string | null;
      players: Record<string, { status: string; seat: number | null }>;
      seatRequests: { playerId: string }[];
    } | null;
  }
): TableMemory {
  if (input.error) return { action: 'clear' };
  if (!input.state) return { action: 'keep' };
  const yourId = input.state.yourId;
  const me = yourId ? input.state.players[yourId] : null;
  if (me && (me.status === 'left' || me.status === 'kicked')) return { action: 'clear' };
  const atTable =
    !!me &&
    !!yourId &&
    (me.seat !== null || input.state.seatRequests.some((r) => r.playerId === yourId));
  if (!atTable) return { action: 'keep' };
  // Standings (including Play again that sends a quick-play night home).
  // Same rule as Hold'em: clear once the last hand is no longer on the felt.
  if (input.state.phase === 'ended' && !reviewingLastHand(input.state)) return { action: 'clear' };
  return { action: 'write', gameId };
}
