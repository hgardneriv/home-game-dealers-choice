import type { GameEvent, LegalActions } from '@/engine/types';

export interface CardsDrawnData {
  playerId: string;
  count: number;
}

/** Same copy as the ActionBar prompt — keep the two surfaces in lockstep. */
export function drawPromptCopy(max: number): string {
  return `Your draw — tap cards on the table to swap (up to ${max})`;
}

export function discardAnnouncementCopy(name: string, count: number): string {
  return count === 0 ? `${name} stood pat` : `${name} discarded ${count}`;
}

/** Max cards the acting player may throw, or null when it is not their draw. */
export function myDrawMax(legal: LegalActions | null): number | null {
  if (!legal || legal.kind !== 'exchange') return null;
  const spec = legal.moves.find((m) => m.kind === 'discard');
  return spec?.kind === 'discard' ? spec.max : null;
}

/**
 * The most recent public discard, but only while it is still "current":
 * we are on the draw street, and nobody has acted since that discard
 * (a later fold, leave, or street change clears it). The engine also
 * emits a paired `action` + `turn` after every draw — those do not count.
 */
function asCardsDrawn(data: unknown): CardsDrawnData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { playerId?: unknown; count?: unknown };
  if (typeof d.playerId !== 'string') return null;
  if (!Number.isInteger(d.count) || (d.count as number) < 0) return null;
  return { playerId: d.playerId, count: d.count as number };
}

function isPairedDrawAction(data: unknown, drawn: CardsDrawnData): boolean {
  const d = data as { playerId?: unknown; move?: unknown };
  return (
    d.playerId === drawn.playerId && (d.move === 'draw' || d.move === 'stand pat')
  );
}

export function currentDiscardAnnouncement(
  events: GameEvent[],
  hand: { street: string; roundKind: string } | null
): CardsDrawnData | null {
  if (!hand || hand.roundKind !== 'exchange' || hand.street !== 'draw') return null;

  let latest: CardsDrawnData | null = null;
  let superseded = false;
  for (const e of events) {
    if (e.type === 'cards-drawn') {
      const drawn = asCardsDrawn(e.data);
      if (!drawn) continue;
      latest = drawn;
      superseded = false;
      continue;
    }
    if (!latest || e.type !== 'action' || isPairedDrawAction(e.data, latest)) continue;
    superseded = true;
  }
  return superseded ? null : latest;
}
