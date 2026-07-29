import { Redis } from '@upstash/redis';
import type { GameState } from '@/engine/types';

/**
 * Versioned game storage with compare-and-set semantics.
 *
 * Keys: `g:{id}:v` (version counter) and `g:{id}:s` (state JSON), both with a
 * 24h TTL refreshed on every write. All mutations flow through `cas`, which
 * atomically bumps the version — concurrent writers race and exactly one wins.
 */
export interface GameKV {
  read(gameId: string): Promise<{ version: number; state: GameState } | null>;
  /** Cheap version-only read — the SSE stream polls this. */
  readVersion(gameId: string): Promise<number>;
  /** Write iff the stored version equals `expectedVersion` (0 = key absent). Returns the new version, or 0 on conflict. */
  cas(gameId: string, expectedVersion: number, state: GameState): Promise<number>;
}

const TTL_SECONDS = 24 * 60 * 60;

const CAS_SCRIPT = `
local v = redis.call('GET', KEYS[1])
if v == false then v = '0' end
if v == ARGV[1] then
  local nv = tonumber(ARGV[1]) + 1
  redis.call('SET', KEYS[1], tostring(nv), 'EX', tonumber(ARGV[3]))
  redis.call('SET', KEYS[2], ARGV[2], 'EX', tonumber(ARGV[3]))
  return nv
end
return 0
`;

/** Vercel Marketplace provisions KV_REST_API_*; a direct Upstash setup uses UPSTASH_REDIS_REST_*. */
function redisCreds(): { url: string; token: string } | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

class RedisKV implements GameKV {
  private redis: Redis;
  constructor(creds: { url: string; token: string }) {
    this.redis = new Redis({ ...creds, automaticDeserialization: false });
  }

  async read(gameId: string) {
    const [v, s] = await this.redis.mget<[string | null, string | null]>(
      `g:${gameId}:v`,
      `g:${gameId}:s`
    );
    if (!v || !s) return null;
    return { version: Number(v), state: JSON.parse(s) as GameState };
  }

  async readVersion(gameId: string) {
    const v = await this.redis.get<string>(`g:${gameId}:v`);
    return v ? Number(v) : 0;
  }

  async cas(gameId: string, expectedVersion: number, state: GameState) {
    const result = await this.redis.eval(
      CAS_SCRIPT,
      [`g:${gameId}:v`, `g:${gameId}:s`],
      [String(expectedVersion), JSON.stringify(state), String(TTL_SECONDS)]
    );
    return Number(result);
  }
}

/** In-memory fallback for local dev (no Upstash env) and unit tests. */
export class MemoryKV implements GameKV {
  private store = new Map<string, { version: number; json: string }>();

  async read(gameId: string) {
    const entry = this.store.get(gameId);
    if (!entry) return null;
    return { version: entry.version, state: JSON.parse(entry.json) as GameState };
  }

  async readVersion(gameId: string) {
    return this.store.get(gameId)?.version ?? 0;
  }

  async cas(gameId: string, expectedVersion: number, state: GameState) {
    const entry = this.store.get(gameId);
    const current = entry?.version ?? 0;
    if (current !== expectedVersion) return 0;
    const version = current + 1;
    this.store.set(gameId, { version, json: JSON.stringify(state) });
    return version;
  }
}

declare global {
  var __gameKV: GameKV | undefined;
}

/** Singleton KV — survives Next.js dev HMR via globalThis. */
export function getKV(): GameKV {
  if (!globalThis.__gameKV) {
    const creds = redisCreds();
    if (!creds && process.env.NODE_ENV === 'production') {
      throw new Error('Redis env vars (KV_REST_API_URL/TOKEN) are required in production');
    }
    globalThis.__gameKV = creds ? new RedisKV(creds) : new MemoryKV();
  }
  return globalThis.__gameKV;
}
