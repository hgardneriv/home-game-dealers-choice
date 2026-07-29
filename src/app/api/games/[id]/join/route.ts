import { nanoid } from 'nanoid';
import { withGame } from '@/server/store';
import { buildSetCookie, playerIdFromRequest } from '@/server/identity';
import { json, readJson, storeResponse } from '@/server/api';
import { redactForPlayer } from '@/server/redact';

export const dynamic = 'force-dynamic';

/** Request a seat. Body: { name, seat? }. Sets the identity cookie. */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: gameId } = await params;
  const body = await readJson(req);
  const name = String(body.name ?? '').trim().slice(0, 20);
  if (!name) return json({ error: { code: 'bad-request', message: 'Name required' } }, 400);
  const seat = Number.isInteger(body.seat) ? (body.seat as number) : 0;

  // Returning player (cookie already present) just reads state.
  const existing = playerIdFromRequest(req, gameId);
  if (existing) {
    const result = await withGame(gameId);
    return storeResponse(result, existing);
  }

  const playerId = `u_${nanoid(10)}`;
  const result = await withGame(gameId, () => ({
    type: 'requestSeat',
    playerId,
    name,
    seat,
  }));
  if (!result.ok) return storeResponse(result, null);
  return json(
    { state: redactForPlayer(result.state, playerId) },
    200,
    { 'set-cookie': buildSetCookie(gameId, playerId) }
  );
}
