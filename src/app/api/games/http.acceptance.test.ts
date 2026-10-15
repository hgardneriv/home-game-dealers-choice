import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryKV } from '@/server/kv';
import { setLimiterForTests } from '@/server/ratelimit';
import { POST as createGame } from './route';
import { POST as joinGame } from './[id]/join/route';
import { POST as seatOp } from './[id]/seats/route';
import { POST as hostOp } from './[id]/host/route';
import { POST as playerAction } from './[id]/action/route';
import { GET as getState } from './[id]/state/route';
import { GET as getStream } from './[id]/stream/route';

/**
 * Black-box HTTP acceptance against this app's routes: ante, enabled
 * variants, and the dealer's pick. Assert status, cookies, and redacted
 * JSON only — deck, discards, and face-down cards stay off the wire.
 */

type RouteCtx = { params: Promise<{ id: string }> };

function ctx(id: string): RouteCtx {
  return { params: Promise.resolve({ id }) };
}

function cookieFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  return raw.split(';')[0] ?? null;
}

function jsonReq(url: string, body: unknown, cookie?: string | null): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method: 'POST', headers, body: JSON.stringify(body) });
}

function getReq(url: string, cookie?: string | null, signal?: AbortSignal): Request {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new Request(url, { method: 'GET', headers, signal });
}

function assertNoSecrets(payload: unknown) {
  const text = JSON.stringify(payload);
  expect(text).not.toContain('"deck"');
  expect(text).not.toContain('"discards"');
  expect(text).not.toContain('"playerCards"');
  expect(text).not.toContain('"vstate"');
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

async function create(body: unknown) {
  const res = await createGame(jsonReq('http://localhost/api/games', body));
  const data = await readJson(res);
  const cookie = cookieFrom(res);
  return { res, data, cookie, gameId: data.gameId as string | undefined };
}

async function stateOf(gameId: string, cookie?: string | null) {
  const res = await getState(getReq(`http://localhost/api/games/${gameId}/state`, cookie), ctx(gameId));
  const data = await readJson(res);
  return { res, data, state: data.state as Record<string, unknown> | undefined };
}

beforeEach(() => {
  globalThis.__gameKV = new MemoryKV();
  setLimiterForTests(undefined);
});

afterEach(() => {
  globalThis.__gameKV = undefined;
  setLimiterForTests(undefined);
});

describe('rate limits', () => {
  it('returns 429 on create, join, stream, action, host, seats, and chooseGame', async () => {
    setLimiterForTests({ limit: async () => ({ success: false }) });
    const blockedCreate = await create({ name: 'Ada' });
    expect(blockedCreate.res.status).toBe(429);
    expect(blockedCreate.data).toMatchObject({ error: { code: 'rate-limited' } });

    setLimiterForTests(undefined);
    const ok = await create({
      name: 'Ada',
      config: { enabledVariants: ['holdem', 'five-draw'], ante: 1, minBet: 2 },
    });
    expect(ok.res.status).toBe(200);
    const { gameId, cookie } = ok;

    setLimiterForTests({ limit: async () => ({ success: false }) });
    const join = await joinGame(
      jsonReq(`http://localhost/api/games/${gameId}/join`, { name: 'Pat', seat: 1 }),
      ctx(gameId!)
    );
    expect(join.status).toBe(429);

    const stream = await getStream(getReq(`http://localhost/api/games/${gameId}/stream`), ctx(gameId!));
    expect(stream.status).toBe(429);
    expect(await stream.json()).toMatchObject({ error: { code: 'rate-limited' } });

    const act = await playerAction(
      jsonReq(`http://localhost/api/games/${gameId}/action`, { move: 'fold' }, cookie),
      ctx(gameId!)
    );
    expect(act.status).toBe(429);

    const choose = await playerAction(
      jsonReq(
        `http://localhost/api/games/${gameId}/action`,
        { move: 'chooseGame', variant: 'holdem' },
        cookie
      ),
      ctx(gameId!)
    );
    expect(choose.status).toBe(429);
    expect(await choose.json()).toMatchObject({ error: { code: 'rate-limited' } });

    const host = await hostOp(
      jsonReq(`http://localhost/api/games/${gameId}/host`, { op: 'start' }, cookie),
      ctx(gameId!)
    );
    expect(host.status).toBe(429);

    const seats = await seatOp(
      jsonReq(`http://localhost/api/games/${gameId}/seats`, { op: 'approve', playerId: 'x' }, cookie),
      ctx(gameId!)
    );
    expect(seats.status).toBe(429);
  });

  it('counts a stream connection open once, not each poll inside it', async () => {
    const { gameId, cookie } = await create({ name: 'Ada', bots: 1 });
    let calls = 0;
    setLimiterForTests({
      limit: async () => {
        calls += 1;
        return { success: true };
      },
    });
    const ac = new AbortController();
    const res = await getStream(
      getReq(`http://localhost/api/games/${gameId}/stream`, cookie, ac.signal),
      ctx(gameId!)
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    ac.abort();
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, 700));
    expect(calls).toBe(1);
  });
});

describe('POST /api/games', () => {
  it('rejects a missing name', async () => {
    const { res, data } = await create({ name: '   ' });
    expect(res.status).toBe(400);
    expect(data).toMatchObject({ error: { code: 'bad-request' } });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('quick play mints a host cookie, seats five bots, and forces top-ups off', async () => {
    const { res, cookie, gameId } = await create({
      name: 'Ada',
      quickPlay: true,
      config: { topUps: 9 },
    });
    expect(res.status).toBe(200);
    expect(gameId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cookie).toMatch(new RegExp(`^hg_${gameId}=`));
    expect(res.headers.get('set-cookie')).toContain('HttpOnly');

    const { state } = await stateOf(gameId!, cookie);
    expect(state).toBeDefined();
    assertNoSecrets(state);
    expect(state!.hosted).toBe(false);
    expect(state!.phase).toBe('choosing');
    expect((state!.config as { topUps: number; ante: number }).topUps).toBe(0);
    expect((state!.config as { ante: number }).ante).toBeGreaterThan(0);
    const players = Object.values(state!.players as Record<string, { isBot: boolean }>);
    expect(players.filter((p) => p.isBot)).toHaveLength(5);
    expect(state!.yourId).toBeTruthy();
    expect((state!.config as { enabledVariants: string[] }).enabledVariants.length).toBeGreaterThan(1);
  });

  it('hosted create stays in the lobby with ante, min-bet, and the enabled games', async () => {
    const { res, cookie, gameId } = await create({
      name: 'Host',
      bots: 2,
      config: {
        startingStack: 40,
        ante: 3,
        minBet: 6,
        topUps: 2,
        enabledVariants: ['guts', 'five-draw'],
      },
    });
    expect(res.status).toBe(200);
    const { state } = await stateOf(gameId!, cookie);
    expect(state!.phase).toBe('lobby');
    expect(state!.hosted).toBe(true);
    expect(state!.config).toMatchObject({
      startingStack: 40,
      ante: 3,
      minBet: 6,
      topUps: 2,
      enabledVariants: ['guts', 'five-draw'],
    });
    const bots = Object.values(state!.players as Record<string, { isBot: boolean }>).filter((p) => p.isBot);
    expect(bots).toHaveLength(2);
    expect(state!.hand).toBeNull();
  });
});

describe('cookie identity and redaction', () => {
  it('anonymous snapshot has null yourId; the host cookie is the host', async () => {
    const { cookie, gameId } = await create({ name: 'Host' });
    const anon = await stateOf(gameId!);
    expect(anon.res.status).toBe(200);
    assertNoSecrets(anon.state);
    expect(anon.state!.yourId).toBeNull();

    const host = await stateOf(gameId!, cookie);
    expect(host.state!.yourId).toBeTruthy();
    expect(host.state!.yourId).toBe(host.state!.hostId);
  });

  it('404s an unknown game', async () => {
    const { res, data } = await stateOf('missing');
    expect(res.status).toBe(404);
    expect(data).toMatchObject({ error: { code: 'not-found' } });
  });

  it('a guest cookie is one seat request, and the same cookie does not join twice', async () => {
    const { cookie: hostCookie, gameId } = await create({ name: 'Host' });
    const joinRes = await joinGame(
      jsonReq(`http://localhost/api/games/${gameId}/join`, { name: 'Pat', seat: 1 }),
      ctx(gameId!)
    );
    expect(joinRes.status).toBe(200);
    const guestCookie = cookieFrom(joinRes);
    expect(guestCookie).toMatch(new RegExp(`^hg_${gameId}=`));
    const joined = await readJson(joinRes);
    assertNoSecrets(joined.state);
    const guestState = joined.state as { yourId: string; seatRequests: { playerId: string }[] };
    expect(guestState.seatRequests.some((r) => r.playerId === guestState.yourId)).toBe(true);

    const again = await joinGame(
      jsonReq(`http://localhost/api/games/${gameId}/join`, { name: 'Pat Two', seat: 2 }, guestCookie),
      ctx(gameId!)
    );
    expect(again.status).toBe(200);
    expect(cookieFrom(again)).toBeNull();
    const againState = (await readJson(again)).state as { yourId: string };
    expect(againState.yourId).toBe(guestState.yourId);

    const hostView = await stateOf(gameId!, hostCookie);
    const names = Object.values(hostView.state!.players as Record<string, { name: string }>).map((p) => p.name);
    expect(names.filter((n) => n.startsWith('Pat'))).toEqual(['Pat']);
  });

  it('approving a guest keeps face-down cards off the wire after the dealer calls hold\'em', async () => {
    const created = await create({
      name: 'Host',
      config: { ante: 2, minBet: 4, enabledVariants: ['holdem', 'five-draw'] },
    });
    const joinRes = await joinGame(
      jsonReq(`http://localhost/api/games/${created.gameId}/join`, { name: 'Pat', seat: 1 }),
      ctx(created.gameId!)
    );
    const guestCookie = cookieFrom(joinRes);
    const guestId = ((await readJson(joinRes)).state as { yourId: string }).yourId;
    const approved = await seatOp(
      jsonReq(
        `http://localhost/api/games/${created.gameId}/seats`,
        { op: 'approve', playerId: guestId },
        created.cookie
      ),
      ctx(created.gameId!)
    );
    expect(approved.status).toBe(200);
    const seated = (await readJson(approved)).state as {
      hosted: boolean;
      players: Record<string, { seat: number | null }>;
    };
    expect(seated.hosted).toBe(true);
    expect(seated.players[guestId].seat).toBeTypeOf('number');

    const started = await hostOp(
      jsonReq(`http://localhost/api/games/${created.gameId}/host`, { op: 'start' }, created.cookie),
      ctx(created.gameId!)
    );
    const choosing = (await readJson(started)).state as {
      phase: string;
      choosing: { dealerId: string } | null;
    };
    expect(choosing.phase).toBe('choosing');
    const dealerCookie = choosing.choosing!.dealerId === guestId ? guestCookie : created.cookie;
    const picked = await playerAction(
      jsonReq(
        `http://localhost/api/games/${created.gameId}/action`,
        { move: 'chooseGame', variant: 'holdem' },
        dealerCookie
      ),
      ctx(created.gameId!)
    );
    expect(picked.status).toBe(200);

    const host = await stateOf(created.gameId!, created.cookie);
    const guest = await stateOf(created.gameId!, guestCookie);
    const anon = await stateOf(created.gameId!);
    for (const view of [host.state, guest.state, anon.state]) assertNoSecrets(view);

    const hostHand = host.state!.hand as {
      variant: string;
      street: string;
      myCards: string[] | null;
      publicCards: Record<string, string[]>;
      cardCounts: Record<string, number>;
    };
    expect(host.state!.phase).toBe('playing');
    expect(hostHand.variant).toBe('holdem');
    expect(hostHand.myCards).toHaveLength(2);
    expect(hostHand.publicCards[guestId] ?? []).toEqual([]);
    expect(hostHand.cardCounts[guestId]).toBe(2);

    const guestHand = guest.state!.hand as { myCards: string[] | null };
    expect(guestHand.myCards).toHaveLength(2);
    const hostText = JSON.stringify(host.state);
    for (const card of guestHand.myCards!) expect(hostText).not.toContain(`"${card}"`);
    const anonText = JSON.stringify(anon.state);
    for (const card of [...hostHand.myCards!, ...guestHand.myCards!]) {
      expect(anonText).not.toContain(`"${card}"`);
    }
  });
});
