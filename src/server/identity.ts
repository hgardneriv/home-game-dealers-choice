import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Per-game player identity via a signed httpOnly cookie — no accounts.
 * Cookie `hg_{gameId}` holds `{playerId}.{HMAC-SHA256(playerId:gameId)}`.
 * A refresh (or reopening the link) presents the cookie and restores the seat.
 */

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (s) return s;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET is required in production');
  }
  return 'dev-secret-not-for-production';
}

function hmac(playerId: string, gameId: string): string {
  return createHmac('sha256', secret()).update(`${playerId}:${gameId}`).digest('base64url');
}

export function signPlayerToken(playerId: string, gameId: string): string {
  return `${playerId}.${hmac(playerId, gameId)}`;
}

export function verifyPlayerToken(token: string, gameId: string): string | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const playerId = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = hmac(playerId, gameId);
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return playerId;
}

export function cookieName(gameId: string): string {
  return `hg_${gameId}`;
}

export function buildSetCookie(gameId: string, playerId: string): string {
  const attrs = [
    `${cookieName(gameId)}=${signPlayerToken(playerId, gameId)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${7 * 24 * 60 * 60}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

/** Extract and verify the player id for a game from a request's cookies. */
export function playerIdFromRequest(req: Request, gameId: string): string | null {
  const header = req.headers.get('cookie');
  if (!header) return null;
  const name = cookieName(gameId);
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return verifyPlayerToken(part.slice(eq + 1).trim(), gameId);
  }
  return null;
}
