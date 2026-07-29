import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import {
  buildSetCookie,
  cookieName,
  playerIdFromRequest,
  signPlayerToken,
  verifyPlayerToken,
} from './identity';

/**
 * First-ever coverage of the auth boundary. These tests pin the exact token
 * format (`{playerId}.{HMAC-SHA256(playerId:gameId, secret)}` base64url), the
 * secret-resolution rules, and every rejection path in verification/parsing.
 */

const SECRET = 'test-secret-123';
const DEV_SECRET = 'dev-secret-not-for-production';

/** Reference HMAC computed independently of the implementation under test. */
function refMac(playerId: string, gameId: string, secret: string): string {
  return createHmac('sha256', secret).update(`${playerId}:${gameId}`).digest('base64url');
}

beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('signPlayerToken', () => {
  it('produces exactly {playerId}.{HMAC-SHA256(playerId:gameId, SESSION_SECRET)} in base64url', () => {
    const token = signPlayerToken('alice', 'game1');
    expect(token).toBe(`alice.${refMac('alice', 'game1', SECRET)}`);
  });

  it('signs with the dev fallback secret when SESSION_SECRET is unset outside production', () => {
    vi.stubEnv('SESSION_SECRET', '');
    // vitest runs with NODE_ENV=test, so the dev fallback applies.
    const token = signPlayerToken('alice', 'game1');
    expect(token).toBe(`alice.${refMac('alice', 'game1', DEV_SECRET)}`);
  });

  it('throws (mentioning SESSION_SECRET) when the secret is unset in production', () => {
    vi.stubEnv('SESSION_SECRET', '');
    vi.stubEnv('NODE_ENV', 'production');
    expect(() => signPlayerToken('alice', 'game1')).toThrow(/SESSION_SECRET/);
  });

  it('works in production when SESSION_SECRET is set', () => {
    vi.stubEnv('NODE_ENV', 'production');
    expect(signPlayerToken('alice', 'game1')).toBe(`alice.${refMac('alice', 'game1', SECRET)}`);
  });
});

describe('verifyPlayerToken', () => {
  it('accepts a token it signed and returns the playerId', () => {
    const token = signPlayerToken('alice', 'game1');
    expect(verifyPlayerToken(token, 'game1')).toBe('alice');
  });

  it('accepts playerIds containing dots (split on the LAST dot)', () => {
    const token = signPlayerToken('a.b.c', 'game1');
    expect(verifyPlayerToken(token, 'game1')).toBe('a.b.c');
  });

  it('rejects a token whose playerId was tampered with', () => {
    const mac = refMac('alice', 'game1', SECRET);
    expect(verifyPlayerToken(`bob.${mac}`, 'game1')).toBeNull();
  });

  it('rejects a same-length tampered signature', () => {
    const token = signPlayerToken('alice', 'game1');
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
    expect(flipped.length).toBe(token.length);
    expect(verifyPlayerToken(flipped, 'game1')).toBeNull();
  });

  it('rejects a truncated signature without throwing (length mismatch)', () => {
    const token = signPlayerToken('alice', 'game1');
    expect(verifyPlayerToken(token.slice(0, -5), 'game1')).toBeNull();
  });

  it('rejects a token signed for a different game', () => {
    const token = signPlayerToken('alice', 'game1');
    expect(verifyPlayerToken(token, 'game2')).toBeNull();
  });

  it('rejects a token with no dot separator', () => {
    expect(verifyPlayerToken('aliceabc123', 'game1')).toBeNull();
  });

  it('rejects a token with an empty playerId even when the mac itself is valid', () => {
    // dot at index 0 must be rejected (dot <= 0), never treated as pid "".
    const token = `.${refMac('', 'game1', SECRET)}`;
    expect(verifyPlayerToken(token, 'game1')).toBeNull();
  });

  it('rejects the empty token', () => {
    expect(verifyPlayerToken('', 'game1')).toBeNull();
  });
});

describe('cookieName', () => {
  it('is hg_{gameId}', () => {
    expect(cookieName('abc123')).toBe('hg_abc123');
  });
});

describe('buildSetCookie', () => {
  it('emits the exact attribute list outside production (no Secure)', () => {
    const token = signPlayerToken('p1', 'g1');
    expect(buildSetCookie('g1', 'p1')).toBe(
      `hg_g1=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`
    );
  });

  it('appends Secure in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const cookie = buildSetCookie('g1', 'p1');
    expect(cookie.endsWith('; Secure')).toBe(true);
    expect(cookie).toContain('Max-Age=604800');
  });
});

describe('playerIdFromRequest', () => {
  function reqWithCookie(cookie: string | null): Request {
    return new Request('http://localhost/x', {
      headers: cookie === null ? {} : { cookie },
    });
  }

  it('returns the playerId for a valid cookie among others', () => {
    const token = signPlayerToken('alice', 'g1');
    const req = reqWithCookie(`foo=1; hg_g1=${token}; bar=2`);
    expect(playerIdFromRequest(req, 'g1')).toBe('alice');
  });

  it('handles the cookie being the only one (no leading space to trim)', () => {
    const token = signPlayerToken('alice', 'g1');
    expect(playerIdFromRequest(reqWithCookie(`hg_g1=${token}`), 'g1')).toBe('alice');
  });

  it('trims whitespace around the cookie value', () => {
    const token = signPlayerToken('alice', 'g1');
    expect(playerIdFromRequest(reqWithCookie(`hg_g1= ${token} `), 'g1')).toBe('alice');
  });

  it('returns null when there is no cookie header', () => {
    expect(playerIdFromRequest(reqWithCookie(null), 'g1')).toBeNull();
  });

  it('returns null when only unrelated cookies are present', () => {
    expect(playerIdFromRequest(reqWithCookie('foo=1; bar=2'), 'g1')).toBeNull();
  });

  it('does not match a cookie whose name merely contains hg_{gameId}', () => {
    const token = signPlayerToken('alice', 'g1');
    expect(playerIdFromRequest(reqWithCookie(`xhg_g1=${token}`), 'g1')).toBeNull();
  });

  it('does not treat another game cookie as this game', () => {
    const token = signPlayerToken('alice', 'g2');
    expect(playerIdFromRequest(reqWithCookie(`hg_g2=${token}`), 'g1')).toBeNull();
  });

  it('rejects a tampered token presented via cookie', () => {
    const token = signPlayerToken('alice', 'g1');
    const mac = token.slice(token.lastIndexOf('.') + 1);
    expect(playerIdFromRequest(reqWithCookie(`hg_g1=mallory.${mac}`), 'g1')).toBeNull();
  });

  it('skips malformed cookie parts without an equals sign', () => {
    const token = signPlayerToken('alice', 'g1');
    expect(playerIdFromRequest(reqWithCookie(`junk; hg_g1=${token}`), 'g1')).toBe('alice');
  });
});
