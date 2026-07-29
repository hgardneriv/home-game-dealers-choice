import { randomInt } from 'node:crypto';
import { nanoid } from 'nanoid';
import type { Action, EngineError, GameState } from '@/engine/types';
import { applyAction, createGame, normalizeConfig } from '@/engine/engine';
import type { TableConfig } from '@/engine/types';
import { getKV } from './kv';
import { dueSweepAction } from './sweep';

/**
 * The single mutation pipeline: read -> sweep (timers/bots/next-hand) ->
 * user action -> CAS write -> retry on conflict. Every route goes through
 * here, so all writes are serialized by the version counter.
 */

const MAX_ATTEMPTS = 4;
/** Cap sweep chains per request so a long bot-vs-bot sequence can't stall a response. */
const MAX_SWEEPS_PER_CALL = 30;

export type StoreResult =
  | { ok: true; state: GameState; version: number }
  | { ok: false; status: number; error: EngineError | { code: string; message: string } };

const ctx = () => ({ now: Date.now(), randInt: (n: number) => randomInt(n) });

/**
 * Read the game, apply any due sweep actions (persisting them), then apply an
 * optional user action built from the fresh state. `buildAction` runs on every
 * retry against the latest state; return null to just read, or an error to
 * abort without writing.
 */
export async function withGame(
  gameId: string,
  buildAction?: (state: GameState) => Action | null | { reject: { code: string; message: string; status?: number } }
): Promise<StoreResult> {
  const kv = getKV();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const entry = await kv.read(gameId);
    if (!entry) return { ok: false, status: 404, error: { code: 'not-found', message: 'Game not found' } };

    let state = entry.state;
    let dirty = false;

    // Run due server actions (bot turns chain until the next one isn't due yet).
    for (let i = 0; i < MAX_SWEEPS_PER_CALL; i++) {
      const c = ctx();
      const due = dueSweepAction(state, c.now, c.randInt);
      if (!due) break;
      const res = applyAction(state, due, c);
      if (!res.ok) break; // e.g. lost a race with a player action; harmless
      state = res.state;
      dirty = true;
    }

    // User action on top of the swept state.
    let userError: { code: string; message: string; status?: number } | null = null;
    if (buildAction) {
      const built = buildAction(state);
      if (built && 'reject' in built) {
        userError = built.reject;
      } else if (built) {
        const res = applyAction(state, built, ctx());
        if (res.ok) {
          state = res.state;
          dirty = true;
        } else {
          userError = { ...res.error, status: statusFor(res.error.code) };
        }
      }
    }

    if (!dirty) {
      if (userError) return { ok: false, status: userError.status ?? 400, error: userError };
      state.version = entry.version;
      return { ok: true, state, version: entry.version };
    }

    state.version = entry.version + 1;
    const newVersion = await kv.cas(gameId, entry.version, state);
    if (newVersion !== 0) {
      if (userError) return { ok: false, status: userError.status ?? 400, error: userError };
      return { ok: true, state, version: newVersion };
    }
    // Conflict: someone else wrote first — re-read and retry everything.
  }
  return {
    ok: false,
    status: 409,
    error: { code: 'conflict', message: 'The table is busy — try again' },
  };
}

function statusFor(code: string): number {
  switch (code) {
    case 'not-your-turn':
    case 'not-expired':
      return 409;
    case 'not-host':
      return 403;
    case 'unknown-player':
      return 404;
    default:
      return 400;
  }
}

/** Create a new game and persist it at version 1. */
export async function createNewGame(opts: {
  hostName: string;
  config?: Partial<TableConfig>;
  bots?: number;
  autoStart?: boolean;
}): Promise<{ gameId: string; hostId: string; state: GameState }> {
  const kv = getKV();
  const gameId = nanoid(12);
  const hostId = `u_${nanoid(10)}`;
  const c = ctx();
  let state = createGame({
    id: gameId,
    hostId,
    hostName: opts.hostName,
    config: normalizeConfig(opts.config ?? {}),
    now: c.now,
  });

  const botCount = Math.max(0, Math.min(5, Math.floor(opts.bots ?? 0)));
  for (let i = 0; i < botCount; i++) {
    const res = applyAction(state, { type: 'addBot', byId: hostId }, ctx());
    if (res.ok) state = res.state;
  }
  if (opts.autoStart && botCount >= 1) {
    const res = applyAction(state, { type: 'startGame', byId: hostId }, ctx());
    if (res.ok) state = res.state;
  }

  state.version = 1;
  const version = await kv.cas(gameId, 0, state);
  if (version === 0) throw new Error('Failed to create game (id collision?)');
  return { gameId, hostId, state };
}
