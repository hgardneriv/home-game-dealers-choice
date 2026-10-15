import type { Card, HandResult } from '@/engine/types';

/**
 * Face-up hole cards at a seat. Hero always sees their own cards.
 * Once a result exists, everyone who stayed is turned — `hands` is the full
 * field (history already publishes it). `revealed` is only the auto-muck set.
 * Folded players stay down. No result means opponents keep backs (and any
 * mid-hand public up-cards the seat already paints).
 *
 * `result` is written only when the hand ends, so baseball's flip orbit and
 * in-between's third-card window — both mid-hand — are left alone.
 */
export function faceUpHoleCards(
  isYou: boolean,
  playerId: string,
  myCards: readonly Card[] | null | undefined,
  result: Pick<HandResult, 'hands' | 'revealed'> | null | undefined,
  folded: boolean
): Card[] | undefined {
  if (isYou) {
    if (!myCards || myCards.length === 0) return undefined;
    return [...myCards];
  }
  if (folded || !result) return undefined;
  const cards = result.hands[playerId] ?? result.revealed[playerId];
  if (!cards || cards.length === 0) return undefined;
  return [...cards];
}
