import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_PER_HOUR,
  LIMIT_WINDOWS,
  RATE_LIMIT_PREFIX,
  clientIp,
  rateLimited,
  resetRateLimitCacheForTests,
  setLimiterForTests,
} from './ratelimit';

const { constructed } = vi.hoisted(() => ({
  constructed: [] as { prefix: string }[],
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor() {}
  },
}));

vi.mock('@upstash/ratelimit', () => ({
  Ratelimit: class {
    static fixedWindow(tokens: number, window: string) {
      return { type: 'fixed', tokens, window };
    }
    constructor(opts: { prefix: string }) {
      constructed.push({ prefix: opts.prefix });
    }
    limit() {
      return Promise.resolve({ success: true });
    }
  },
}));

afterEach(() => {
  setLimiterForTests(undefined);
  resetRateLimitCacheForTests();
  constructed.length = 0;
  vi.unstubAllEnvs();
});

describe('clientIp', () => {
  it('uses the first x-forwarded-for hop, then x-real-ip, then unknown', () => {
    expect(clientIp(new Request('http://x', { headers: { 'x-forwarded-for': ' 1.1.1.1, 2.2.2.2' } }))).toBe(
      '1.1.1.1'
    );
    expect(clientIp(new Request('http://x', { headers: { 'x-real-ip': '9.9.9.9' } }))).toBe('9.9.9.9');
    expect(clientIp(new Request('http://x'))).toBe('unknown');
  });
});

describe('rateLimited', () => {
  it('is a no-op without Redis or an injected limiter', async () => {
    setLimiterForTests(null);
    expect(await rateLimited('create', 'ip')).toBeNull();
  });

  it('returns 429 when the injected limiter denies', async () => {
    setLimiterForTests({ limit: async () => ({ success: false }) });
    const res = await rateLimited('create', 'ip');
    expect(res?.status).toBe(429);
    expect(await res!.json()).toMatchObject({ error: { code: 'rate-limited' } });
  });

  it('passes through when the injected limiter allows', async () => {
    setLimiterForTests({ limit: async () => ({ success: true }) });
    expect(await rateLimited('join', 'ip')).toBeNull();
  });

  it('is a no-op in next dev even if Redis is configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'token');
    setLimiterForTests(undefined);
    expect(await rateLimited('create', 'ip')).toBeNull();
    expect(constructed).toHaveLength(0);
  });

  it('caps table creates at 10 per hour and keeps the other windows', () => {
    expect(CREATE_PER_HOUR).toBe(10);
    expect(LIMIT_WINDOWS).toEqual({
      create: { tokens: 10, window: '1 h' },
      join: { tokens: 20, window: '1 m' },
      mutate: { tokens: 30, window: '1 m' },
      stream: { tokens: 30, window: '1 m' },
    });
  });

  it('builds Redis limiters under dc:rl: and reuses the cache', async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('KV_REST_API_URL', 'https://example.upstash.io');
    vi.stubEnv('KV_REST_API_TOKEN', 'token');
    setLimiterForTests(undefined);
    expect(await rateLimited('create', 'ip')).toBeNull();
    expect(await rateLimited('join', 'ip')).toBeNull();
    const prefixes = constructed.map((c) => c.prefix).sort();
    expect(prefixes).toEqual([
      'dc:rl:create',
      'dc:rl:join',
      'dc:rl:mutate',
      'dc:rl:stream',
    ]);
    for (const prefix of prefixes) {
      expect(prefix.startsWith(RATE_LIMIT_PREFIX)).toBe(true);
      expect(prefix.startsWith('rl:')).toBe(false);
      expect(prefix.includes('stats:')).toBe(false);
    }
    // Second pass hits the cache — no extra constructors.
    expect(constructed).toHaveLength(4);
  });
});
