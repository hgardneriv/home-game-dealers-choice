import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameState } from '@/engine/types';
import { Table } from '@/engine/test-utils';
import { getKV, MemoryKV, type GameKV } from './kv';
import { createNewGame, withGame } from './store';

/**
 * Hardening tests for the KV layer and the withGame CAS pipeline: retry
 * counts, sweep persistence, error-to-status mapping, creation clamps, and
 * the getKV singleton/env resolution. Complements store.test.ts (which covers
 * the concurrent-CAS race and basic sweep-on-read).
 */

let kv: MemoryKV;

beforeEach(() => {
  kv = new MemoryKV();
  globalThis.__gameKV = kv;
});

afterEach(() => {
  globalThis.__gameKV = undefined;
  vi.unstubAllEnvs();
});

/** Counts calls and optionally forces every CAS to conflict. */
class InstrumentedKV implements GameKV {
  reads = 0;
  casCalls = 0;
  constructor(
    private inner: GameKV,
    private opts: { alwaysConflict?: boolean } = {}
  ) {}
  async read(gameId: string) {
    this.reads++;
    return this.inner.read(gameId);
  }
  async readVersion(gameId: string) {
    return this.inner.readVersion(gameId);
  }
  async cas(gameId: string, expectedVersion: number, state: GameState) {
    this.casCalls++;
    if (this.opts.alwaysConflict) return 0;
    return this.inner.cas(gameId, expectedVersion, state);
  }
}

describe('MemoryKV', () => {
  it('read of a missing game is null; readVersion is 0', async () => {
    expect(await kv.read('nope')).toBeNull();
    expect(await kv.readVersion('nope')).toBe(0);
  });

  it('cas from 0 creates at version 1; stale expectedVersion is rejected with 0', async () => {
    const state = { id: 'g' } as GameState;
    expect(await kv.cas('g', 0, state)).toBe(1);
    expect(await kv.readVersion('g')).toBe(1);
    expect(await kv.cas('g', 0, state)).toBe(0); // stale
    expect(await kv.cas('g', 1, state)).toBe(2);
    expect((await kv.read('g'))!.version).toBe(2);
  });
});

describe('getKV', () => {
  beforeEach(() => {
    globalThis.__gameKV = undefined;
    vi.stubEnv('KV_REST_API_URL', undefined);
    vi.stubEnv('KV_REST_API_TOKEN', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
  });

  it('falls back to MemoryKV without creds and memoizes the instance', () => {
    const a = getKV();
    expect(a.constructor.name).toBe('MemoryKV');
    expect(getKV()).toBe(a);
  });

  it('reuses a preexisting singleton untouched', () => {
    const custom = new MemoryKV();
    globalThis.__gameKV = custom;
    expect(getKV()).toBe(custom);
  });

  it('builds a RedisKV from KV_REST_API_* (Vercel Marketplace names)', () => {
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok');
    expect(getKV().constructor.name).toBe('RedisKV');
  });

  it('builds a RedisKV from UPSTASH_REDIS_REST_* (direct Upstash names)', () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://example.upstash.io');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'tok');
    expect(getKV().constructor.name).toBe('RedisKV');
  });

  it('a URL without a token is not enough — memory fallback', () => {
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io');
    expect(getKV().constructor.name).toBe('MemoryKV');
  });

  it('throws in production without creds', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => getKV()).toThrow(/KV_REST_API_URL/);
  });
});

describe('withGame', () => {
  it('404s for an unknown game', async () => {
    const res = await withGame('missing-game');
    expect(res).toMatchObject({ ok: false, status: 404 });
    if (!res.ok) expect(res.error.code).toBe('not-found');
  });

  it('a pure read (buildAction returns null) never writes', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const counting = new InstrumentedKV(kv);
    globalThis.__gameKV = counting;

    const res = await withGame(gameId, () => null);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.version).toBe(1);
      expect(res.state.version).toBe(1);
    }
    expect(counting.casCalls).toBe(0);
  });

  it('gives up after exactly 4 attempts when every CAS conflicts', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const conflicting = new InstrumentedKV(kv, { alwaysConflict: true });
    globalThis.__gameKV = conflicting;

    const res = await withGame(gameId, () => ({
      type: 'requestSeat',
      playerId: 'uA',
      name: 'Ada',
      seat: 1,
    }));
    expect(res).toMatchObject({ ok: false, status: 409 });
    if (!res.ok) expect(res.error.code).toBe('conflict');
    expect(conflicting.reads).toBe(4);
    expect(conflicting.casCalls).toBe(4);
  });

  it('a successful write returns version 2 with state.version in agreement, persisted', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const res = await withGame(gameId, () => ({
      type: 'requestSeat',
      playerId: 'uA',
      name: 'Ada',
      seat: 1,
    }));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.version).toBe(2);
      expect(res.state.version).toBe(2);
    }
    const stored = await kv.read(gameId);
    expect(stored!.version).toBe(2);
    expect(stored!.state.version).toBe(2);
  });

  it('the reject path surfaces the custom code/status and writes nothing', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const res = await withGame(gameId, () => ({
      reject: { code: 'custom-x', message: 'nope', status: 418 },
    }));
    expect(res).toMatchObject({ ok: false, status: 418 });
    if (!res.ok) expect(res.error).toMatchObject({ code: 'custom-x', message: 'nope' });
    expect((await kv.read(gameId))!.version).toBe(1);
  });

  it('a reject without a status defaults to 400', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const res = await withGame(gameId, () => ({
      reject: { code: 'custom-y', message: 'still nope' },
    }));
    expect(res).toMatchObject({ ok: false, status: 400 });
  });

  it('maps not-your-turn to 409 and unknown-player to 404', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host', bots: 2, autoStart: true });

    const wrongTurn = await withGame(gameId, (state) => {
      const toAct = state.hand!.round.toAct!;
      const other = Object.values(state.players).find((p) => p.id !== toAct)!;
      return { type: 'playerAction', playerId: other.id, move: 'fold' };
    });
    expect(wrongTurn).toMatchObject({ ok: false, status: 409 });
    if (!wrongTurn.ok) expect(wrongTurn.error.code).toBe('not-your-turn');

    const ghost = await withGame(gameId, () => ({ type: 'topUp', playerId: 'ghost' }));
    expect(ghost).toMatchObject({ ok: false, status: 404 });
    if (!ghost.ok) expect(ghost.error.code).toBe('unknown-player');
  });

  it('maps not-expired to 409 (nextHand demanded before its time)', async () => {
    // Seed a hand-over state whose next hand is scheduled in the real future.
    const t = new Table(2);
    t.start();
    t.act('p0', 'fold');
    t.state.nextHandAt = Date.now() + 60_000;
    await kv.cas('seeded1', 0, t.state);

    const res = await withGame('seeded1', () => ({ type: 'nextHand' }));
    expect(res).toMatchObject({ ok: false, status: 409 });
    if (!res.ok) expect(res.error.code).toBe('not-expired');
  });

  it('persists sweep results even on a pure read', async () => {
    // Engine-clock state: nextHandAt (~epoch 1e6) is deep in the real past.
    const t = new Table(2);
    t.start();
    t.act('p0', 'fold');
    await kv.cas('seeded2', 0, t.state);

    const res = await withGame('seeded2');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.phase).toBe('playing'); // the due nextHand was dealt
      expect(res.version).toBe(2);
    }
    const stored = await kv.read('seeded2');
    expect(stored!.version).toBe(2);
    expect(stored!.state.phase).toBe('playing');
  });

  it('persists sweep results even when the user action on top fails', async () => {
    const t = new Table(2);
    t.start();
    t.act('p0', 'fold');
    await kv.cas('seeded3', 0, t.state);

    // After the sweep deals the next hand, startGame is a bad-phase error.
    const res = await withGame('seeded3', () => ({ type: 'startGame', byId: 'p0' }));
    expect(res).toMatchObject({ ok: false, status: 400 });
    const stored = await kv.read('seeded3');
    expect(stored!.version).toBe(2); // the sweep write still happened
    expect(stored!.state.phase).toBe('playing');
  });
});

describe('createNewGame', () => {
  it('mints prefixed ids and persists at version 1 with the host seated', async () => {
    const { gameId, hostId, state } = await createNewGame({ hostName: 'Hostess' });
    expect(gameId).toHaveLength(12);
    expect(hostId.startsWith('u_')).toBe(true);
    expect(hostId).toHaveLength(12);
    expect(state.version).toBe(1);
    expect(state.players[hostId]).toMatchObject({ name: 'Hostess', isHost: true, seat: 0 });
    const stored = await kv.read(gameId);
    expect(stored!.version).toBe(1);
    expect(stored!.state.id).toBe(gameId);
  });

  it('normalizes and applies a partial config', async () => {
    const { state } = await createNewGame({ hostName: 'H', config: { startingStack: 55 } });
    expect(state.config.startingStack).toBe(55);
    expect(state.config.bigBlind).toBe(2); // defaults fill the rest
  });

  it('clamps bot count to 0..5 and adds exactly that many', async () => {
    const seven = await createNewGame({ hostName: 'H', bots: 7 });
    expect(Object.keys(seven.state.players)).toHaveLength(6); // host + 5

    const negative = await createNewGame({ hostName: 'H', bots: -2 });
    expect(Object.keys(negative.state.players)).toHaveLength(1);

    const two = await createNewGame({ hostName: 'H', bots: 2 });
    expect(Object.keys(two.state.players)).toHaveLength(3);
    expect(two.state.phase).toBe('lobby'); // no autoStart
  });

  it('autoStart needs at least one bot, and one is enough', async () => {
    const started = await createNewGame({ hostName: 'H', bots: 1, autoStart: true });
    expect(started.state.phase).toBe('playing');

    const alone = await createNewGame({ hostName: 'H', bots: 0, autoStart: true });
    expect(alone.state.phase).toBe('lobby');

    const notAsked = await createNewGame({ hostName: 'H', bots: 1 });
    expect(notAsked.state.phase).toBe('lobby');
  });

  it('throws when the creation CAS loses (id collision)', async () => {
    globalThis.__gameKV = new InstrumentedKV(kv, { alwaysConflict: true });
    await expect(createNewGame({ hostName: 'H' })).rejects.toThrow(/Failed to create/);
  });
});
