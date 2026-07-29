import { withGame } from '@/server/store';
import { playerIdFromRequest } from '@/server/identity';
import { storeResponse } from '@/server/api';

export const dynamic = 'force-dynamic';

/** Snapshot of the game, redacted for the requesting player. Runs the sweep. */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: gameId } = await params;
  const playerId = playerIdFromRequest(req, gameId);
  const result = await withGame(gameId);
  return storeResponse(result, playerId);
}
