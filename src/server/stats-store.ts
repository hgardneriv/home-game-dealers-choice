import { Redis } from '@upstash/redis';
import { redisCreds } from './kv';

/**
 * House stats — no TTL. Game keys expire in 24h; these must outlive a night.
 * Every key is under `dc:stats:` so this app never touches Hold'em's `stats:`
 * hashes on the shared Redis.
 */

export const STATS_PREFIX = 'dc:stats:';

export interface StatsKV {
  incrBy(key: string, field: string, n: number): Promise<void>;
  hset(key: string, fields: Record<string, string>): Promise<void>;
  hgetall(key: string): Promise<Record<string, string>>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /** true when the key was absent and is now set. */
  setnx(key: string, value: string): Promise<boolean>;
}

/** Build a stats key. Refuses anything outside `dc:stats:`. */
export function statsKey(suffix: string): string {
  const key = `${STATS_PREFIX}${suffix}`;
  if (!key.startsWith(STATS_PREFIX) || key.startsWith('stats:')) {
    throw new Error(`refusing stats key ${key}`);
  }
  return key;
}

/**
 * Upstash + `automaticDeserialization: false` returns HGETALL as a flat
 * [field, value, field, value] array. Treating that as an object made the
 * page show zeros while Redis held the counts.
 */
export function normalizeHgetall(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (Array.isArray(raw)) {
    const out: Record<string, string> = {};
    for (let i = 0; i < raw.length - 1; i += 2) {
      const key = raw[i];
      if (key == null) continue;
      out[String(key)] = raw[i + 1] == null ? '' : String(raw[i + 1]);
    }
    return out;
  }
  if (typeof raw !== 'object') return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    out[k] = v == null ? '' : String(v);
  }
  return out;
}

/** SET NX / SETNX: Upstash may return "OK", true, or 1. */
export function setnxSucceeded(result: unknown): boolean {
  return result === 'OK' || result === true || result === 1 || result === '1';
}

class MemoryStatsKV implements StatsKV {
  private hashes = new Map<string, Record<string, string>>();
  private sets = new Map<string, Set<string>>();
  private strings = new Map<string, string>();

  async incrBy(key: string, field: string, n: number) {
    if (n === 0) return;
    const hash = this.hashes.get(key) ?? {};
    hash[field] = String((Number(hash[field] ?? 0) || 0) + n);
    this.hashes.set(key, hash);
  }

  async hset(key: string, fields: Record<string, string>) {
    const hash = this.hashes.get(key) ?? {};
    Object.assign(hash, fields);
    this.hashes.set(key, hash);
  }

  async hgetall(key: string) {
    return { ...(this.hashes.get(key) ?? {}) };
  }

  async sadd(key: string, member: string) {
    const set = this.sets.get(key) ?? new Set();
    set.add(member);
    this.sets.set(key, set);
  }

  async smembers(key: string) {
    return [...(this.sets.get(key) ?? [])];
  }

  async setnx(key: string, value: string) {
    if (this.strings.has(key)) return false;
    this.strings.set(key, value);
    return true;
  }
}

/** Minimal Redis surface used by house stats (for a fake REST client in tests). */
export interface StatsRedis {
  hincrby(key: string, field: string, n: number): Promise<unknown>;
  hset(key: string, fields: Record<string, string>): Promise<unknown>;
  hgetall(key: string): Promise<unknown>;
  sadd(key: string, member: string): Promise<unknown>;
  smembers(key: string): Promise<unknown>;
  set(key: string, value: string, opts: { nx: true }): Promise<unknown>;
}

class RedisStatsKV implements StatsKV {
  constructor(private redis: StatsRedis) {}

  async incrBy(key: string, field: string, n: number) {
    if (n === 0) return;
    await this.redis.hincrby(key, field, n);
  }

  async hset(key: string, fields: Record<string, string>) {
    if (Object.keys(fields).length === 0) return;
    await this.redis.hset(key, fields);
  }

  async hgetall(key: string) {
    return normalizeHgetall(await this.redis.hgetall(key));
  }

  async sadd(key: string, member: string) {
    await this.redis.sadd(key, member);
  }

  async smembers(key: string) {
    const members = await this.redis.smembers(key);
    return (Array.isArray(members) ? members : []).map(String);
  }

  async setnx(key: string, value: string) {
    return setnxSucceeded(await this.redis.set(key, value, { nx: true }));
  }
}

declare global {
  var __statsKV: StatsKV | undefined;
}

export function createMemoryStatsKV(): StatsKV {
  return new MemoryStatsKV();
}

/** Test seam — same wrapper as production Redis, with a fake REST client. */
export function createRedisStatsKV(redis: StatsRedis): StatsKV {
  return new RedisStatsKV(redis);
}

export function setStatsKVForTests(kv: StatsKV | undefined): void {
  globalThis.__statsKV = kv;
}

export function getStatsKV(): StatsKV {
  if (!globalThis.__statsKV) {
    const creds = redisCreds();
    // Default deserialization: HGETALL should become a map. Game KV keeps
    // automaticDeserialization: false for raw JSON state. The reader still
    // runs normalizeHgetall so a flat array cannot zero the page.
    globalThis.__statsKV = creds
      ? new RedisStatsKV(new Redis({ ...creds }))
      : new MemoryStatsKV();
  }
  return globalThis.__statsKV;
}
