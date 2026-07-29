import { beforeEach, describe, expect, it } from 'vitest';
import type { GameState } from '@/engine/types';
import { MemoryKV, type GameKV } from './kv';
import { createNewGame, withGame } from './store';

/**
 * KV wrapper that delays reads so two concurrent withGame() calls both read
 * the same version and race their CAS writes — one must win, one must retry.
 */
class SlowReadKV implements GameKV {
  constructor(private inner: MemoryKV) {}
  casCalls = 0;
  async read(gameId: string) {
    const result = await this.inner.read(gameId);
    await new Promise((r) => setTimeout(r, 20));
    return result;
  }
  async readVersion(gameId: string) {
    return this.inner.readVersion(gameId);
  }
  async cas(gameId: string, expectedVersion: number, state: GameState) {
    this.casCalls++;
    return this.inner.cas(gameId, expectedVersion, state);
  }
}

describe('store CAS pipeline', () => {
  let kv: SlowReadKV;

  beforeEach(() => {
    kv = new SlowReadKV(new MemoryKV());
    globalThis.__gameKV = kv;
  });

  it('two concurrent conflicting writes: one CAS conflict, both eventually apply', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });

    const [a, b] = await Promise.all([
      withGame(gameId, () => ({
        type: 'requestSeat',
        playerId: 'uA',
        name: 'Alice',
        seat: 1,
      })),
      withGame(gameId, () => ({
        type: 'requestSeat',
        playerId: 'uB',
        name: 'Bob',
        seat: 2,
      })),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // At least one extra CAS attempt happened (the conflict retry).
    expect(kv.casCalls).toBeGreaterThanOrEqual(3);

    const final = await withGame(gameId);
    if (!final.ok) throw new Error('read failed');
    expect(final.state.seatRequests.map((r) => r.name).sort()).toEqual(['Alice', 'Bob']);
    expect(final.version).toBe(3); // create + two writes
  });

  it('a rejected action does not write and surfaces the engine error', async () => {
    const { gameId } = await createNewGame({ hostName: 'Host' });
    const res = await withGame(gameId, () => ({ type: 'startGame', byId: 'not-the-host' }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);

    const after = await withGame(gameId);
    if (!after.ok) throw new Error('read failed');
    expect(after.version).toBe(1); // unchanged
  });

  it('sweep persists due bot actions on a plain read', async () => {
    const { gameId, state } = await createNewGame({
      hostName: 'Host',
      bots: 2,
      autoStart: true,
    });
    expect(state.phase).toBe('playing');

    // Wait until some bot's act-at deadline passes, then just READ.
    await new Promise((r) => setTimeout(r, 30));
    const patched = await (async () => {
      // Force the bot deadline into the past to avoid a slow test.
      const entry = await kv.read(gameId);
      if (!entry) throw new Error('missing');
      if (entry.state.hand?.round.botActAt) {
        entry.state.hand.round.botActAt = Date.now() - 1;
        entry.state.hand.round.actionDeadline = Date.now() + 60_000;
        await kv.cas(gameId, entry.version, entry.state);
      } else if (entry.state.hand) {
        // The random button put the human host first to act (no botActAt).
        // Expire their deadline with the time bank already spent — the first
        // timeout would otherwise just arm the bank and extend the clock —
        // so the sweep's timeout auto-acts and emits an 'action' event.
        entry.state.hand.round.actionDeadline = Date.now() - 2_000;
        entry.state.hand.round.timeBankArmed = true;
        await kv.cas(gameId, entry.version, entry.state);
      }
      return true;
    })();
    expect(patched).toBe(true);

    const read = await withGame(gameId);
    if (!read.ok) throw new Error('read failed');
    // The sweep should have applied at least one bot action (an 'action' event
    // exists beyond the blinds), possibly chaining further.
    const actionEvents = read.state.events.filter((e) => e.type === 'action');
    expect(actionEvents.length).toBeGreaterThanOrEqual(1);
  });
});
