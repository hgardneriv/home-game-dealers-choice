import { createNewGame } from '@/server/store';
import { buildSetCookie } from '@/server/identity';
import { json, readJson } from '@/server/api';
import type { TableConfig } from '@/engine/types';

export const dynamic = 'force-dynamic';

/** Create a game. Body: { name, config?, bots?, quickPlay? }. */
export async function POST(req: Request): Promise<Response> {
  const body = await readJson(req);
  const name = String(body.name ?? '').trim().slice(0, 20);
  if (!name) return json({ error: { code: 'bad-request', message: 'Name required' } }, 400);

  const quickPlay = body.quickPlay === true;
  const bots = quickPlay ? 5 : Number(body.bots ?? 0);
  const config = (typeof body.config === 'object' ? body.config : {}) as Partial<TableConfig>;

  const { gameId, hostId } = await createNewGame({
    hostName: name,
    config,
    bots,
    autoStart: quickPlay,
  });

  return json(
    { gameId },
    200,
    { 'set-cookie': buildSetCookie(gameId, hostId) }
  );
}
