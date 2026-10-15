import { describe, expect, it } from 'vitest';
import { createRedisStatsKV, normalizeHgetall, setnxSucceeded, statsKey, type StatsRedis } from './stats-store';
import { persistStatsDeltas, readStatsSnapshot, type StatsDelta } from './stats';

describe('normalizeHgetall', () => {
  it('turns a flat Redis/Upstash HGETALL array into a field map', () => {
    expect(
      normalizeHgetall(['handsPlayed', '4', 'v:holdem', '3', 'made:holdem:pair', '2'])
    ).toEqual({
      handsPlayed: '4',
      'v:holdem': '3',
      'made:holdem:pair': '2',
    });
  });

  it('keeps an already-parsed object', () => {
    expect(normalizeHgetall({ handsPlayed: 4, 'v:guts': 1 })).toEqual({
      handsPlayed: '4',
      'v:guts': '1',
    });
  });

  it('empty / null is an empty map', () => {
    expect(normalizeHgetall(null)).toEqual({});
    expect(normalizeHgetall([])).toEqual({});
    expect(normalizeHgetall('nope')).toEqual({});
  });
});

describe('setnxSucceeded', () => {
  it('accepts OK / true / 1 from Upstash SET NX', () => {
    expect(setnxSucceeded('OK')).toBe(true);
    expect(setnxSucceeded(true)).toBe(true);
    expect(setnxSucceeded(1)).toBe(true);
    expect(setnxSucceeded('1')).toBe(true);
    expect(setnxSucceeded(null)).toBe(false);
    expect(setnxSucceeded(0)).toBe(false);
  });
});

describe('statsKey', () => {
  it('stays under dc:stats: and never the Hold\'em prefix', () => {
    expect(statsKey('house')).toBe('dc:stats:house');
    expect(statsKey('player:Ada')).toBe('dc:stats:player:Ada');
    expect(statsKey('house').startsWith('dc:stats:')).toBe(true);
    expect(statsKey('house').startsWith('stats:')).toBe(false);
  });
});

/**
 * Fake Upstash REST client: HGETALL returns the raw flat array you get when
 * automatic deserialization is skipped. The page must still see the counts.
 */
function flatHgetallRedis(): StatsRedis {
  const hashes = new Map<string, Record<string, string>>();
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();
  return {
    async hincrby(key, field, n) {
      const hash = hashes.get(key) ?? {};
      hash[field] = String((Number(hash[field] ?? 0) || 0) + n);
      hashes.set(key, hash);
    },
    async hset(key, fields) {
      const hash = hashes.get(key) ?? {};
      Object.assign(hash, fields);
      hashes.set(key, hash);
    },
    async hgetall(key) {
      const hash = hashes.get(key) ?? {};
      return Object.entries(hash).flat();
    },
    async sadd(key, member) {
      const set = sets.get(key) ?? new Set();
      set.add(member);
      sets.set(key, set);
    },
    async smembers(key) {
      return [...(sets.get(key) ?? [])];
    },
    async set(key, value, opts) {
      if (opts.nx && strings.has(key)) return null;
      strings.set(key, value);
      return 'OK';
    },
  };
}

describe('Redis stats through a flat HGETALL', () => {
  it('persisted house counts survive a flat-array HGETALL read', async () => {
    const kv = createRedisStatsKV(flatHgetallRedis());
    const delta: StatsDelta = {
      gameId: 'live',
      hand: {
        fingerprint: 'h:live:1:holdem:1:1',
        variant: 'holdem',
        actors: [
          {
            id: 'u_x',
            name: 'Harry',
            isBot: false,
            won: true,
            calls: 2,
            made: { game: 'holdem', kind: 'pair' },
          },
          { id: 'bot', name: 'Lucky Lou', isBot: true, won: false, calls: 0 },
        ],
      },
    };
    await persistStatsDeltas([delta], kv);
    const snap = await readStatsSnapshot(kv);
    expect(snap.house.handsPlayed).toBe(1);
    expect(snap.house.variants.holdem).toBe(1);
    expect(snap.house.made.holdem?.pair).toBe(1);
    expect(snap.players).toEqual([
      expect.objectContaining({ id: 'Harry', name: 'Harry', hands: 1, wins: 1, calls: 2 }),
    ]);
    expect(snap.bots[0]).toMatchObject({ name: 'Lucky Lou', calls: 0, hands: 1, wins: 0 });
    const raw = await kv.hgetall(statsKey('house'));
    expect(raw['made:holdem:pair']).toBe('1');
    expect(raw.pair).toBeUndefined();
  });
});
