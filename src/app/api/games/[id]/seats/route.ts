import { withGame } from '@/server/store';
import { playerIdFromRequest } from '@/server/identity';
import { json, readJson, storeResponse } from '@/server/api';

export const dynamic = 'force-dynamic';

/** Host seat management. Body: { op: 'approve' | 'deny', playerId }. */
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
  if (!['approve', 'deny'].includes(op) || !playerId)
    return json({ error: { code: 'bad-request', message: 'Bad request' } }, 400);

  const result = await withGame(gameId, () =>
    op === 'approve'
      ? { type: 'approveSeat', byId, playerId }
      : { type: 'denySeat', byId, playerId }
  );
  return storeResponse(result, byId);
}
