import { withGame } from '@/server/store';
import { playerIdFromRequest } from '@/server/identity';
import { json, readJson, storeResponse } from '@/server/api';
import type { PlayerMove, VariantId, VariantMoveInput } from '@/engine/types';

/** Whitelist-shape a wire variant move; null = malformed. */
function parseVariantMove(body: Record<string, unknown>): VariantMoveInput | null {
  switch (String(body.kind ?? (Array.isArray(body.cardIndexes) ? 'discard' : ''))) {
    case 'discard': {
      const raw: unknown[] = Array.isArray(body.cardIndexes) ? body.cardIndexes : [];
      const cardIndexes = raw.filter((n): n is number => Number.isInteger(n)).slice(0, 10);
      return { kind: 'discard', cardIndexes };
    }
    case 'declare': {
      const choice = String(body.choice ?? '');
      return choice === 'in' || choice === 'out' ? { kind: 'declare', choice } : null;
    }
    case 'flip':
      return { kind: 'flip' };
    case 'wager': {
      const amount = Number(body.amount ?? NaN);
      return Number.isInteger(amount) && amount >= 0 ? { kind: 'wager', amount } : null;
    }
    case 'aceCall':
      return { kind: 'aceCall', high: body.high === true };
    default:
      return null;
  }
}
import { getLegalActions } from '@/engine/betting';

export const dynamic = 'force-dynamic';

const MOVES: PlayerMove[] = ['fold', 'check', 'call', 'bet', 'raise'];

/**
 * Player actions. Body: { move, amount?, expectedCall? } for betting moves,
 * or { move: 'imBack' | 'leave' | 'topUp' }.
 *
 * `expectedCall` guards stale taps: if a raise landed after the client
 * rendered its Call button, the call amount changed and we 409 instead of
 * silently calling more than the player saw.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: gameId } = await params;
  const playerId = playerIdFromRequest(req, gameId);
  if (!playerId)
    return json({ error: { code: 'unauthorized', message: 'Not in this game' } }, 401);

  const body = await readJson(req);
  const move = String(body.move ?? '');

  // Top-up amount is server-authoritative (from config + topUpsUsed) — never
  // taken from the wire.
  if (move === 'imBack' || move === 'leave' || move === 'topUp') {
    const result = await withGame(gameId, () => ({ type: move, playerId }));
    return storeResponse(result, playerId);
  }

  // Dealer's call. The engine validates the variant against the enabled list
  // and the sender against the choosing dealer — the route only shapes it.
  if (move === 'chooseGame') {
    const variant = String(body.variant ?? '') as VariantId;
    const result = await withGame(gameId, () => ({ type: 'chooseGame', playerId, variant }));
    return storeResponse(result, playerId);
  }

  // Exchange-round move. Shape-check only — the variant module validates
  // semantics through the same path getLegalActions exposes.
  if (move === 'variantMove') {
    const parsed = parseVariantMove(body);
    if (!parsed)
      return json({ error: { code: 'bad-request', message: 'Unknown variant move' } }, 400);
    const result = await withGame(gameId, () => ({
      type: 'variantMove',
      playerId,
      move: parsed,
    }));
    return storeResponse(result, playerId);
  }

  if (!MOVES.includes(move as PlayerMove))
    return json({ error: { code: 'bad-request', message: 'Unknown move' } }, 400);
  const amount = typeof body.amount === 'number' ? body.amount : undefined;
  const expectedCall = typeof body.expectedCall === 'number' ? body.expectedCall : null;

  const result = await withGame(gameId, (state) => {
    if (move === 'call' && expectedCall !== null) {
      const legal = getLegalActions(state, playerId);
      if (legal && legal.kind === 'betting' && legal.callAmount !== expectedCall) {
        return {
          reject: {
            code: 'stale-action',
            message: `Call amount changed to ${legal.callAmount}`,
            status: 409,
          },
        };
      }
    }
    return { type: 'playerAction', playerId, move: move as PlayerMove, amount };
  });
  return storeResponse(result, playerId);
}
