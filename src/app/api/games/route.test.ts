import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameKV } from '@/server/kv';
import { POST } from './route';

/**
 * Production 2026-08-26: the shared free Redis hit its monthly command cap.
 * createNewGame's CAS threw, the route let it bubble, Next.js returned an
 * empty 500, and Safari's res.json() surfaced as
 * "The string did not match the expected pattern."
 *
 * The create endpoint must answer with JSON the client can show — never an
 * uncaught storage throw.
 */

const QUOTA = 'ERR max requests limit exceeded. Limit: 500000, Usage: 500002.';

class QuotaExceededKV implements GameKV {
  async read(): Promise<never> {
    throw new Error(QUOTA);
  }
  async readVersion(): Promise<never> {
    throw new Error(QUOTA);
  }
  async cas(): Promise<never> {
    throw new Error(QUOTA);
  }
}

function createReq(body: unknown): Request {
  return new Request('http://localhost/api/games', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/games', () => {
  beforeEach(() => {
    globalThis.__gameKV = new QuotaExceededKV();
  });

  afterEach(() => {
    globalThis.__gameKV = undefined;
  });

  it('returns JSON 503 when the table store is over quota (Play now)', async () => {
    const res = await POST(createReq({ name: 'Harry', quickPlay: true }));
    expect(res.status).toBe(503);
    const data = await res.json();
    expect(data.error?.code).toBe('storage-unavailable');
    expect(data.error?.message).toMatch(/try again/i);
    expect(data.error?.message).not.toMatch(/expected pattern/i);
  });
});
