import { withGame } from '@/server/store';
import { playerIdFromRequest } from '@/server/identity';
import { json, readJson, storeResponse } from '@/server/api';
import type { Action } from '@/engine/types';

export const dynamic = 'force-dynamic';

/** Host controls. Body: { op: 'start'|'pause'|'resume'|'kick'|'addBot'|'removeBot', playerId? }. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: gameId } = await params;
  const byId = playerIdFromRequest(req, gameId);
  if (!byId)
    return json({ error: { code: 'unauthorized', message: 'Not in this game' } }, 401);

  const body = await readJson(req);
  const op = String(body.op ?? '');
  const playerId = String(body.playerId ?? '');

  const action: Action | null =
    op === 'start' ? { type: 'startGame', byId }
    : op === 'pause' ? { type: 'pause', byId }
    : op === 'resume' ? { type: 'resume', byId }
    : op === 'endGame' ? { type: 'endGame', byId }
    : op === 'kick' && playerId ? { type: 'kick', byId, playerId }
    : op === 'addBot' ? { type: 'addBot', byId }
    : op === 'removeBot' && playerId ? { type: 'removeBot', byId, playerId }
    : null;

  if (!action) return json({ error: { code: 'bad-request', message: 'Bad request' } }, 400);
  const result = await withGame(gameId, () => action);
  return storeResponse(result, byId);
}
