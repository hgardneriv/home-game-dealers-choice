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
  const config = (
    typeof body.config === 'object' && body.config !== null ? body.config : {}
  ) as Partial<TableConfig>;
  // Top-ups are a hosted-game feature: quick play stays a fast disposable
  // session where busting out ends it. Hosted tables use the form config
  // (and its default of 2), applying to bots and humans alike.
  if (quickPlay) config.topUps = 0;

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
