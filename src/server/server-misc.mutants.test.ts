import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Table, NOW } from '@/engine/test-utils';
import type { GameState, HandState, VariantId, VariantMoveInput } from '@/engine/types';
import type { GameVariant } from '@/engine/variants/types';
import {
  IMPLEMENTED_VARIANTS,
  _registerVariantForTest,
  getVariant,
  isImplemented,
} from '@/engine/variants/registry';
import { holdem } from '@/engine/variants/holdem';
import { CATEGORY, describe as describeHand, evaluate5, evaluate7 } from '@/engine/evaluator';
import { applyMove, nextToAct } from '@/engine/betting';
import { buildPots } from '@/engine/pots';
import { seatingAt } from '@/engine/seating';
import { resolveShowdown } from '@/engine/showdown';
import { topUpAmount } from '@/engine/topup';
import { MemoryKV, getKV, type GameKV } from './kv';
import { createNewGame, withGame } from './store';
import { dueSweepAction } from './sweep';
import { redactForPlayer } from './redact';
import { playerIdFromRequest, signPlayerToken } from './identity';

/**
 * Mutation-hardening pins for the server layer + engine leftovers. One test
 * file on purpose (parallel agents own the sibling files).
 *
 * Documented (not killed) survivors — analyzed equivalent or unreachable:
 *
 * evaluator.ts
 *  - 24:19 `i <= 5` in pack(): the extra slot ORs `0 << -4` = 0 — no-op.
 *  - 32:7 / 50:17: `ranks.length !== 5` guard and `counts.size === 5` gate are
 *    mutually redundant (each alone still blocks non-5-unique straights).
 *  - 35:44: with ranks[0]===14 and ranks[1]===5 over 5 distinct ranks, the
 *    remaining ranks are forced to 4,3,2 — the third wheel clause is implied.
 *  - 47:70 / 48:22/48:46/48:56: both sorts run over inputs whose relevant
 *    order is already established (values are pre-sorted desc, so Map
 *    insertion order is rank-desc within equal counts); degrading or dropping
 *    the tie-break comparator leaves TimSort's stable order unchanged
 *    (verified: [[13,1],[3,2],[2,2]] keeps its order under `b[0]+a[0]`).
 *  - 60:7 (`groups[0][1] === 2` -> true): implied clause — groups are sorted
 *    by count desc, so groups[1][1]===2 forces groups[0][1] >= 2, and quads/
 *    full-house/trips categories have already returned above.
 *  - 72:19/73:25/73:18 (evaluate7 loop bounds): the mutants only ADD candidate
 *    evaluations over 6-card sets, whose scores never exceed the true best
 *    5-card score (pairs/flushes reduce to their top-5; 6 distinct ranks can
 *    never register as a straight because counts.size !== 5).
 *  - 79:11 `score >= best`: same max, ties overwrite with an equal value.
 *
 * betting.ts
 *  - 53:7: the early `able.length === 0` return is an optimization — the loop
 *    below finds nobody and returns null anyway.
 *  - 92:17 (`toCall > 0` -> `>=`/true in callAmount): committed never exceeds
 *    currentBet, so toCall >= 0; at 0, `Math.min(0, stack)` is still 0.
 *  - 166:23 (`isAllIn` -> false): minRaiseTo is already capped at maxRaiseTo,
 *    so an all-in (to === maxRaiseTo) always satisfies `to >= minRaiseTo`; the
 *    isAllIn escape hatch is defensive and unreachable.
 *  - 175:11/176:11 (`>=` -> `>` on full-raise boundaries): at the exact
 *    boundary the "cumulative short all-in" elif produces an identical state
 *    (same lastFullRaiseSize/lastFullRaiseTo/actedSinceFullRaise), because
 *    to - lastFullRaiseTo >= lastFullRaiseSize is implied there and the new
 *    size (to - prevBet) equals the old size.
 *
 * pots.ts — all 11 survivors are equivalent, by the same two shields:
 *  - zero-contribution ids (23:15/23:42×2, 24:7, 29:21×2): a player with 0
 *    committed can't change top/secondMax (both fall back to 0), contributes 0
 *    to every layer, and never reaches any level's eligibility bar; the empty
 *    `ids` early-return recomputes to the same `{refunds:{}, pots:[]}`.
 *  - level-0 layers (38:18, 39:20×2, 50:9×2): a 0 level yields amount 0 and
 *    is dropped by the `amount > 0` guard (and vice versa — contesting totals
 *    are all > 0, so `amount > 0` never actually rejects).
 *
 * seating.ts
 *  - 55:7: computeButton's `< 2` guard duplicates seatingAt's (killed here);
 *    with the guard mutated away, seatingAt still returns null.
 *  - 59:19/59:53/59:63: eligiblePlayers maps state.seats in ascending seat
 *    order, so `seats` is pre-sorted; removing/degrading the sort is a no-op.
 *
 * showdown.ts — 67:11 (both, on `if (remainder > 0) remainder--`): once the
 *  odd chips run out, extra decrements only drive remainder negative; the
 *  share ternary (`remainder > 0 ? 1 : 0`) treats 0 and negative alike, so
 *  payouts are identical (that ternary IS pinned by the odd-chip test below).
 *
 * topup.ts — 21:7 (both): documented in the source itself; at max === 0 the
 *  `used >= max` clause already returns 0 (used is never negative).
 *
 * sweep.ts — 47:13 (`if (decision)` -> true): from this call site the round
 *  kind is always 'betting' and the bot is toAct, so decideForBot always
 *  returns a clamped decision — the null branch is unreachable.
 *
 * redact.ts — 138:21 (`h.round.toAct === playerId` -> true): the outer
 *  `playerId &&` still guards spectators, and getLegalActions itself returns
 *  null whenever toAct !== playerId — the redaction-side clause is a
 *  duplicate of that guard.
 *
 * store.ts
 *  - 102:5 (statusFor's `default: return 400` removed): the undefined status
 *    is masked by `userError.status ?? 400` at both return sites — the
 *    response is 400 either way.
 *  - 45:21/45:46 (sweep-cap loop): the cap only binds after 30 consecutive
 *    *due* server actions inside one call; bot delays are wall-clock based, so
 *    that chain cannot be constructed deterministically in a unit test.
 *  - 50:11 (`if (!res.ok) break` -> false): a rejected due action leaves state
 *    untouched, so the loop just spins to the cap and exits with identical
 *    output (a pure perf guard).
 *  - 129:9/131:25/133:9 (createNewGame guards): bots are clamped to 5 with 6
 *    seats, so addBot never fails; startGame is only attempted with >= 2
 *    players (host+bot) so it never fails; and when it IS forced to fail
 *    (autoStart with 0 bots under mutant 131:25) the 133 guard discards it.
 */

/* ------------------------------------------------------------------ */
/* kv.ts                                                              */
/* ------------------------------------------------------------------ */

const upstash = vi.hoisted(() => ({
  ctorOpts: [] as unknown[],
  mget: vi.fn(),
  get: vi.fn(),
  eval: vi.fn(),
}));

vi.mock('@upstash/redis', () => ({
  Redis: class {
    mget = upstash.mget;
    get = upstash.get;
    eval = upstash.eval;
    constructor(opts: unknown) {
      upstash.ctorOpts.push(opts);
    }
  },
}));

const fakeState = { id: 'g', phase: 'lobby', seats: [] } as unknown as GameState;

describe('kv: RedisKV via getKV with stubbed env + mocked client', () => {
  beforeEach(() => {
    globalThis.__gameKV = undefined;
    upstash.ctorOpts.length = 0;
    upstash.mget.mockReset();
    upstash.get.mockReset();
    upstash.eval.mockReset();
    vi.stubEnv('KV_REST_API_URL', 'https://kv.example');
    vi.stubEnv('KV_REST_API_TOKEN', 'tok-123');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    globalThis.__gameKV = undefined;
  });

  it('constructs Redis with the exact creds and automaticDeserialization: false', () => {
    getKV();
    expect(upstash.ctorOpts).toEqual([
      { url: 'https://kv.example', token: 'tok-123', automaticDeserialization: false },
    ]);
  });

  it('read: mgets the exact version+state keys and parses both', async () => {
    upstash.mget.mockResolvedValueOnce(['3', '{"id":"abc","phase":"lobby"}']);
    const res = await getKV().read('abc');
    expect(upstash.mget).toHaveBeenCalledWith('g:abc:v', 'g:abc:s');
    expect(res).toEqual({ version: 3, state: { id: 'abc', phase: 'lobby' } });
  });

  it('read: null when the version key, the state key, or both are missing', async () => {
    const kv = getKV();
    upstash.mget.mockResolvedValueOnce([null, '{"id":"abc"}']);
    expect(await kv.read('abc')).toBeNull();
    upstash.mget.mockResolvedValueOnce(['3', null]);
    expect(await kv.read('abc')).toBeNull();
    upstash.mget.mockResolvedValueOnce([null, null]);
    expect(await kv.read('abc')).toBeNull();
  });

  it('readVersion: gets the exact version key; Number on hit, 0 on miss', async () => {
    const kv = getKV();
    upstash.get.mockResolvedValueOnce('7');
    expect(await kv.readVersion('abc')).toBe(7);
    expect(upstash.get).toHaveBeenCalledWith('g:abc:v');
    upstash.get.mockResolvedValueOnce(null);
    expect(await kv.readVersion('abc')).toBe(0);
  });

  it('cas: evals the CAS script with exact keys and [expected, json, 24h TTL] args', async () => {
    upstash.eval.mockResolvedValueOnce(5);
    const result = await getKV().cas('abc', 4, fakeState);
    expect(result).toBe(5);
    expect(upstash.eval).toHaveBeenCalledTimes(1);
    const [script, keys, args] = upstash.eval.mock.calls[0];
    expect(script).toContain("redis.call('GET', KEYS[1])");
    expect(keys).toEqual(['g:abc:v', 'g:abc:s']);
    expect(args).toEqual(['4', JSON.stringify(fakeState), String(24 * 60 * 60)]);
  });

  it('falls back to UPSTASH_REDIS_REST_* creds', () => {
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://up.example');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'up-tok');
    getKV();
    expect(upstash.ctorOpts).toEqual([
      { url: 'https://up.example', token: 'up-tok', automaticDeserialization: false },
    ]);
  });

  it('without creds (non-production) getKV returns a cached MemoryKV singleton', () => {
    vi.stubEnv('KV_REST_API_URL', '');
    vi.stubEnv('KV_REST_API_TOKEN', '');
    const kv = getKV();
    expect(kv).toBeInstanceOf(MemoryKV);
    expect(getKV()).toBe(kv);
  });
});

describe('kv: MemoryKV CAS semantics', () => {
  it('cas succeeds only on the expected version and bumps it', async () => {
    const kv = new MemoryKV();
    expect(await kv.cas('g', 1, fakeState)).toBe(0); // absent = version 0
    expect(await kv.cas('g', 0, fakeState)).toBe(1);
    expect(await kv.cas('g', 0, fakeState)).toBe(0); // stale writer loses
    expect(await kv.cas('g', 1, fakeState)).toBe(2);
    expect(await kv.readVersion('g')).toBe(2);
  });

  it('read returns a JSON snapshot (later mutation of the source object is invisible)', async () => {
    const kv = new MemoryKV();
    const state = { id: 'g', phase: 'lobby' } as unknown as GameState;
    await kv.cas('g', 0, state);
    (state as { phase: string }).phase = 'ended';
    const read = await kv.read('g');
    expect(read).toEqual({ version: 1, state: { id: 'g', phase: 'lobby' } });
  });

  it('read/readVersion on an absent game: null and 0', async () => {
    const kv = new MemoryKV();
    expect(await kv.read('nope')).toBeNull();
    expect(await kv.readVersion('nope')).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* store.ts                                                           */
/* ------------------------------------------------------------------ */

describe('store: withGame statuses and messages', () => {
  beforeEach(() => {
    globalThis.__gameKV = new MemoryKV();
  });
  afterEach(() => {
    globalThis.__gameKV = undefined;
  });

  async function seed(state: GameState): Promise<string> {
    await getKV().cas(state.id, 0, state);
    return state.id;
  }

  /** Playing state whose deadlines are future *wall-clock* time — no sweeps fire. */
  function quietPlaying(): Table {
    const t = new Table(2);
    t.start();
    t.hand.round.actionDeadline = Date.now() + 60_000;
    return t;
  }

  it("missing game: 404 with 'Game not found'", async () => {
    const res = await withGame('missing-id');
    expect(res).toEqual({
      ok: false,
      status: 404,
      error: { code: 'not-found', message: 'Game not found' },
    });
  });

  it('statusFor: unknown-player maps to 404, generic errors to 400', async () => {
    const t = quietPlaying();
    const id = await seed(t.state);

    const notFound = await withGame(id, () => ({ type: 'topUp', playerId: 'ghost' }));
    expect(notFound.ok).toBe(false);
    if (!notFound.ok) {
      expect(notFound.status).toBe(404);
      expect(notFound.error.code).toBe('unknown-player');
    }

    const bad = await withGame(id, (s) => ({
      type: 'playerAction',
      playerId: s.hand!.round.toAct!,
      move: 'bet',
      amount: 2.5,
    }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.status).toBe(400);
      expect(bad.error.code).toBe('bad-amount');
    }
  });

  it('a dirty sweep + failing user action keeps the mapped status (409, not 400)', async () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold'); // hand-over; nextHandAt is NOW-based, i.e. long past
    expect(t.state.phase).toBe('hand-over');
    const id = await seed(t.state);

    const res = await withGame(id, (s) => ({
      type: 'playerAction',
      playerId: s.hand!.round.toAct === 'p0' ? 'p1' : 'p0', // wrong player on purpose
      move: 'fold',
    }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(409);
      expect(res.error.code).toBe('not-your-turn');
    }
    // The sweep result (the freshly dealt hand) was still persisted.
    const read = await withGame(id);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.state.phase).toBe('playing');
  });

  it("permanent CAS conflict: 409 'The table is busy — try again' after MAX_ATTEMPTS reads", async () => {
    const t = quietPlaying();
    const entry = { version: 1, state: t.state };
    let reads = 0;
    const conflictKV: GameKV = {
      async read() {
        reads++;
        return structuredClone(entry);
      },
      async readVersion() {
        return entry.version;
      },
      async cas() {
        return 0;
      },
    };
    globalThis.__gameKV = conflictKV;

    const res = await withGame('game1', (s) => ({
      type: 'playerAction',
      playerId: s.hand!.round.toAct!,
      move: 'fold',
    }));
    expect(res).toEqual({
      ok: false,
      status: 409,
      error: { code: 'conflict', message: 'The table is busy — try again' },
    });
    expect(reads).toBe(4);
  });

  it('createNewGame: bots are added and autoStart only fires with at least one bot', async () => {
    const started = await createNewGame({ hostName: 'H', bots: 2, autoStart: true });
    expect(Object.keys(started.state.players)).toHaveLength(3);
    expect(started.state.phase).not.toBe('lobby');
    expect(started.state.version).toBe(1);

    const lobby = await createNewGame({ hostName: 'H', bots: 0, autoStart: true });
    expect(Object.keys(lobby.state.players)).toHaveLength(1);
    expect(lobby.state.phase).toBe('lobby');
  });
});

/* ------------------------------------------------------------------ */
/* sweep.ts — choosing phase                                          */
/* ------------------------------------------------------------------ */

describe('sweep: choosing-phase gating and boundaries', () => {
  /** 3 humans, two enabled variants: startGame parks in choosing (dealer p0). */
  function choosingTable(): Table {
    const t = new Table(3, {
      config: { enabledVariants: ['holdem', 'five-draw'] as VariantId[] },
    });
    t.start();
    expect(t.state.phase).toBe('choosing');
    expect(t.state.choosing).toMatchObject({ dealerId: 'p0', botChooseAt: null });
    return t;
  }

  it('human dealer: chooseTimeout exactly at deadline + 1000ms grace, not at +999', () => {
    const t = choosingTable();
    const deadline = t.state.choosing!.deadline;
    expect(dueSweepAction(t.state, deadline + 999, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline + 1000, t.randInt)).toEqual({
      type: 'chooseTimeout',
    });
  });

  it('a stale botChooseAt on a HUMAN dealer never picks for them', () => {
    const t = choosingTable();
    t.state.choosing!.botChooseAt = NOW; // due, but the dealer is human
    expect(dueSweepAction(t.state, NOW + 1, t.randInt)).toBeNull();
  });

  it('bot dealer: picks exactly at botChooseAt (>=, not >)', () => {
    const t = choosingTable();
    t.state.players.p0.isBot = true;
    t.state.choosing!.botChooseAt = NOW + 5000;
    expect(dueSweepAction(t.state, NOW + 4999, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, NOW + 5000, t.randInt)).toEqual({
      type: 'chooseGame',
      playerId: 'p0',
      variant: 'holdem', // zeroRand -> first fitting enabled variant
    });
  });

  it('bot dealer with botChooseAt null: no pick before the deadline, zero-grace timeout at it', () => {
    const t = choosingTable();
    t.state.players.p0.isBot = true;
    expect(t.state.choosing!.botChooseAt).toBeNull();
    const deadline = t.state.choosing!.deadline;
    expect(dueSweepAction(t.state, deadline - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline, t.randInt)).toEqual({ type: 'chooseTimeout' });
  });

  it('vanished dealer (id not in players): human grace applies and nothing throws', () => {
    const t = choosingTable();
    t.state.choosing!.dealerId = 'ghost';
    const deadline = t.state.choosing!.deadline;
    expect(dueSweepAction(t.state, deadline + 999, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline + 1000, t.randInt)).toEqual({
      type: 'chooseTimeout',
    });
  });

  it('phase choosing with choosing state missing: nothing due, nothing throws', () => {
    const t = choosingTable();
    const s = structuredClone(t.state);
    s.choosing = null;
    expect(dueSweepAction(s, NOW + 10_000_000, t.randInt)).toBeNull();
  });

  it('outside the choosing phase a stale choosing object is ignored (nextHand wins)', () => {
    const t = choosingTable();
    const s = structuredClone(t.state);
    const late = s.choosing!.deadline + 5000;
    s.phase = 'hand-over';
    s.nextHandAt = late; // stale s.choosing kept on purpose
    expect(dueSweepAction(s, late, t.randInt)).toEqual({ type: 'nextHand' });
  });
});

/* ------------------------------------------------------------------ */
/* sweep.ts — exchange rounds + betting.ts exchange guard             */
/* ------------------------------------------------------------------ */

describe('sweep: bot exchange turns (stub exchange variant)', () => {
  let botMove: VariantMoveInput | undefined;
  let autoMove: VariantMoveInput | undefined;

  const swapStub: GameVariant = {
    id: 'five-draw',
    name: 'Swap (stub)',
    marquee: 'SWAP',
    layoutHint: 'per-player',
    minPlayers: 2,
    fitsPlayers: (n) => n >= 2 && n <= 6,
    deal(v) {
      for (const id of v.hand.inHand) {
        v.hand.playerCards[id] = { cards: [v.draw()], faceUp: [false] };
      }
      return { kind: 'exchange', street: 'swap' };
    },
    nextPhase() {
      return { kind: 'showdown' };
    },
    score: () => 0,
    describeScore: () => '',
    exchange: {
      legal: () => ({
        kind: 'exchange',
        moves: [{ kind: 'wager', min: 0, max: 9 }],
        autoMove: autoMove as VariantMoveInput,
      }),
      apply: () => ({ applied: { move: 'noop' } }),
    },
    bot: {
      decideBet: () => ({ move: 'check' }),
      decideExchange: () => botMove as VariantMoveInput,
    },
  };

  let unregister: () => void;
  beforeEach(() => {
    botMove = undefined;
    autoMove = undefined;
    unregister = _registerVariantForTest(swapStub);
  });
  afterEach(() => unregister());

  /** Host + bot in the stub's exchange round, bot to act with botActAt stamped. */
  function exchangeTable(): { t: Table; botId: string } {
    const t = new Table(1, { config: { enabledVariants: ['five-draw'] as VariantId[] } });
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = Object.keys(t.state.players).find((id) => id !== 'p0')!;
    t.start();
    expect(t.state.phase).toBe('playing');
    expect(t.hand.round.kind).toBe('exchange');
    expect(t.toAct).toBe(botId);
    expect(t.hand.round.botActAt).not.toBeNull();
    return { t, botId };
  }

  it("returns the bot's exchange move as a variantMove exactly at botActAt", () => {
    botMove = { kind: 'wager', amount: 2 };
    const { t, botId } = exchangeTable();
    const at = t.hand.round.botActAt!;
    expect(dueSweepAction(t.state, at - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, at, t.randInt)).toEqual({
      type: 'variantMove',
      playerId: botId,
      move: { kind: 'wager', amount: 2 },
    });
  });

  it('no decision and no auto move: falls through silently, then the timeout backstop fires', () => {
    const { t } = exchangeTable();
    const at = t.hand.round.botActAt!;
    expect(dueSweepAction(t.state, at, t.randInt)).toBeNull();
    // Bot grace is 0: the backstop fires exactly at the action deadline.
    const deadline = t.hand.round.actionDeadline!;
    expect(dueSweepAction(t.state, deadline - 1, t.randInt)).toBeNull();
    expect(dueSweepAction(t.state, deadline, t.randInt)).toEqual({ type: 'timeout' });
  });

  it("betting.applyMove refuses exchange rounds with 'Not a betting round'", () => {
    autoMove = { kind: 'wager', amount: 0 };
    const { t, botId } = exchangeTable();
    const res = applyMove(t.state, botId, 'fold', undefined);
    expect(res).toEqual({
      error: { code: 'illegal-move', message: 'Not a betting round' },
    });
    expect(t.hand.folded).toEqual([]); // and nothing was applied
  });
});

/* ------------------------------------------------------------------ */
/* betting.ts                                                         */
/* ------------------------------------------------------------------ */

describe('betting: turn walk and amount validation', () => {
  it('nextToAct wraps all the way back to fromId when everyone else is out', () => {
    const hand = {
      inHand: ['a', 'b'],
      folded: ['b'],
      allIn: [],
      round: {
        kind: 'betting',
        street: 'x',
        currentBet: 5,
        lastFullRaiseSize: 5,
        lastFullRaiseTo: 5,
        committed: {},
        actedSinceFullRaise: [],
        lastAggressor: null,
        toAct: 'a',
        actionDeadline: null,
        timeBankArmed: false,
        botActAt: null,
      },
    } as unknown as HandState;
    expect(nextToAct(hand, 'a')).toBe('a');
  });

  it('rejects a fractional bet amount with the whole-number message', () => {
    const t = new Table(2);
    t.start();
    const res = t.tryAct('p1', 'bet', 2.5);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('bad-amount');
      expect(res.error.message).toBe('Amount must be a whole number');
    }
  });

  it('a re-raise pays only the delta above chips already committed this street', () => {
    const t = new Table(2, { stacks: [50, 50] });
    t.start(); // ante 1 each -> stacks 49
    t.act('p1', 'bet', 5); // p1: 49 - 5 = 44
    t.act('p0', 'raise', 15); // p0: 49 - 15 = 34
    t.act('p1', 'raise', 30); // pays 30 - 5 = 25 -> 19
    expect(t.stack('p1')).toBe(19);
    expect(t.hand.round.committed.p1).toBe(30);
    expect(t.hand.totalCommitted.p1).toBe(31); // ante + 30
    expect(t.hand.round.currentBet).toBe(30);
  });
});

/* ------------------------------------------------------------------ */
/* pots.ts (pins; survivors documented above)                         */
/* ------------------------------------------------------------------ */

describe('pots: refund and layering arithmetic', () => {
  function handWith(
    totals: Record<string, number>,
    folded: string[] = [],
    inHand = Object.keys(totals)
  ): HandState {
    return { inHand, folded, totalCommitted: totals } as unknown as HandState;
  }

  it('refunds the uncalled excess to the sole over-contributor', () => {
    const { refunds, pots } = buildPots(handWith({ a: 10, b: 4 }));
    expect(refunds).toEqual({ a: 6 });
    expect(pots).toEqual([{ amount: 8, eligible: ['a', 'b'] }]);
  });

  it('layers a short all-in into main + side pots', () => {
    const { refunds, pots } = buildPots(handWith({ a: 10, b: 10, c: 4 }));
    expect(refunds).toEqual({});
    expect(pots).toEqual([
      { amount: 12, eligible: ['a', 'b', 'c'] },
      { amount: 12, eligible: ['a', 'b'] },
    ]);
  });

  it("a folder's chips land in the layers they reached without eligibility", () => {
    const { refunds, pots } = buildPots(handWith({ a: 10, b: 10, c: 4 }, ['c']));
    expect(refunds).toEqual({});
    expect(pots).toEqual([{ amount: 24, eligible: ['a', 'b'] }]);
  });

  it('zero-contribution in-hand players change nothing', () => {
    const withZero = buildPots(handWith({ a: 5, b: 5, c: 0 }));
    expect(withZero).toEqual(buildPots(handWith({ a: 5, b: 5 })));
    expect(withZero.pots).toEqual([{ amount: 10, eligible: ['a', 'b'] }]);
  });
});

/* ------------------------------------------------------------------ */
/* seating.ts / showdown.ts / topup.ts                                */
/* ------------------------------------------------------------------ */

describe('seating: seatingAt', () => {
  it('returns null with fewer than two eligible players', () => {
    const t = new Table(1); // host alone
    expect(seatingAt(t.state, 0)).toBeNull();
  });
});

describe('showdown: odd-chip distribution', () => {
  it('gives the odd chip to the first winner clockwise only', () => {
    const hand = {
      inHand: ['a', 'b', 'c'],
      folded: [],
      allIn: [],
      totalCommitted: { a: 7, b: 7, c: 7 },
      playerCards: {
        a: { cards: ['As', 'Ks'], faceUp: [false, false] },
        b: { cards: ['Ad', 'Kd'], faceUp: [false, false] },
        c: { cards: ['2c', '3c'], faceUp: [false, false] },
      },
      round: { lastAggressor: null },
    } as unknown as HandState;
    const { result, payouts } = resolveShowdown(
      hand,
      (_h, id) => (id === 'c' ? 1 : 5),
      (s) => `score ${s}`
    );
    expect(result.pots).toEqual([{ amount: 21, winners: ['a', 'b'], eligible: ['a', 'b', 'c'] }]);
    expect(payouts).toEqual({ a: 11, b: 10 }); // 21 split two ways, odd chip to a
  });
});

describe('topup: schedule boundaries (equivalence pin)', () => {
  const cfg = (over: Record<string, number>) =>
    ({ startingStack: 20, minBet: 2, topUps: 2, topUpDecayPct: 50, ...over }) as never;

  it('returns 0 when disabled, exhausted, or decayed below the min bet', () => {
    expect(topUpAmount(cfg({ topUps: 0 }), 0)).toBe(0);
    expect(topUpAmount(cfg({}), 2)).toBe(0);
    expect(topUpAmount(cfg({ topUps: 9 }), 4)).toBe(0); // 12 * 0.5^4 rounds to 1 < minBet
    expect(topUpAmount(cfg({ topUps: 9, topUpDecayPct: 90 }), 2)).toBe(0); // 12 * 0.01 -> 0
  });

  it('first top-up is 60% of the buy-in, then decays from the rounded first', () => {
    expect(topUpAmount(cfg({}), 0)).toBe(12);
    expect(topUpAmount(cfg({}), 1)).toBe(6);
  });
});

/* ------------------------------------------------------------------ */
/* variants/holdem.ts                                                 */
/* ------------------------------------------------------------------ */

describe('holdem: fitsPlayers boundaries', () => {
  it('accepts exactly 2..6 players', () => {
    expect(holdem.fitsPlayers(1)).toBe(false);
    expect(holdem.fitsPlayers(2)).toBe(true);
    expect(holdem.fitsPlayers(6)).toBe(true);
    expect(holdem.fitsPlayers(7)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* variants/registry.ts                                               */
/* ------------------------------------------------------------------ */

describe('registry: getVariant / _registerVariantForTest restore semantics', () => {
  function stubFor(id: string): GameVariant {
    return {
      id: id as VariantId,
      name: `stub-${id}`,
      marquee: id.toUpperCase(),
      layoutHint: 'board',
      minPlayers: 2,
      fitsPlayers: () => true,
      deal: () => ({ kind: 'showdown' }),
      nextPhase: () => ({ kind: 'showdown' }),
      score: () => 0,
      describeScore: () => '',
      bot: { decideBet: () => ({ move: 'check' }) },
    };
  }

  it('getVariant throws a message naming the missing variant', () => {
    expect(() => getVariant('bogus' as VariantId)).toThrow('Variant not implemented: bogus');
  });

  it('shadowing an existing id never duplicates the listing and restores the original', () => {
    const before = [...IMPLEMENTED_VARIANTS];
    const stub = stubFor('holdem');
    const unregister = _registerVariantForTest(stub);
    expect(getVariant('holdem')).toBe(stub);
    expect(IMPLEMENTED_VARIANTS).toEqual(before); // no duplicate push
    unregister();
    expect(getVariant('holdem')).toBe(holdem); // the real module is back
    expect(IMPLEMENTED_VARIANTS).toEqual(before);
  });

  it('registering a brand-new id lists it; unregistering fully removes it', () => {
    const before = [...IMPLEMENTED_VARIANTS];
    const stub = stubFor('zzz-test');
    const unregister = _registerVariantForTest(stub);
    expect(isImplemented('zzz-test')).toBe(true);
    expect(IMPLEMENTED_VARIANTS).toContain('zzz-test');
    expect(getVariant('zzz-test' as VariantId)).toBe(stub);
    unregister();
    expect(isImplemented('zzz-test')).toBe(false); // key deleted, not set undefined
    expect(IMPLEMENTED_VARIANTS).not.toContain('zzz-test');
    expect(IMPLEMENTED_VARIANTS).toEqual(before);
    expect(() => getVariant('zzz-test' as VariantId)).toThrow();
  });

  it('double-unregister is a no-op (never splices an unrelated entry)', () => {
    const unregister = _registerVariantForTest(stubFor('zzz-twice'));
    unregister();
    const snapshot = [...IMPLEMENTED_VARIANTS];
    unregister(); // id no longer listed; must not touch the array
    expect(IMPLEMENTED_VARIANTS).toEqual(snapshot);
  });

  it('unregister removes the id even from index 0 of the listing', () => {
    const snapshot = IMPLEMENTED_VARIANTS.splice(0, IMPLEMENTED_VARIANTS.length);
    try {
      const unregister = _registerVariantForTest(stubFor('zzz-first'));
      expect(IMPLEMENTED_VARIANTS.indexOf('zzz-first' as VariantId)).toBe(0);
      unregister();
      expect(IMPLEMENTED_VARIANTS).toHaveLength(0);
    } finally {
      IMPLEMENTED_VARIANTS.push(...snapshot);
    }
  });
});

/* ------------------------------------------------------------------ */
/* evaluator.ts                                                       */
/* ------------------------------------------------------------------ */

describe('evaluator: misclassification pins', () => {
  it('A-9-8-7-6 is NOT a wheel — high card Ace', () => {
    const score = evaluate5(['As', '9c', '8d', '7h', '6s']);
    expect(score >> 20).toBe(CATEGORY.highCard);
    expect(describeHand(score)).toBe('High Card Ace');
  });

  it('one pair never reads as two pair', () => {
    const score = evaluate5(['9c', '9d', 'As', '7h', '4s']);
    expect(score >> 20).toBe(CATEGORY.pair);
    expect(describeHand(score)).toBe('Pair of Nines');
  });

  it('two pair orders the pairs by rank, not by appearance', () => {
    const score = evaluate5(['2c', '2d', '3h', '3s', 'Kd']);
    expect(score >> 20).toBe(CATEGORY.twoPair);
    expect(describeHand(score)).toBe('Two Pair, Threes and Twos');
    // Bigger top pair must strictly outrank, regardless of the second pair.
    expect(evaluate5(['Kc', 'Kh', '2h', '2s', '4d'])).toBeGreaterThan(score);
  });

  it('detects seven-high and wheel straights', () => {
    const seven = evaluate5(['7c', '6d', '5h', '4s', '3c']);
    expect(describeHand(seven)).toBe('Straight, Seven High');
    const wheel = evaluate5(['Ah', '5d', '4c', '3s', '2h']);
    expect(describeHand(wheel)).toBe('Straight, Five High');
    expect(seven).toBeGreaterThan(wheel);
  });

  it('evaluate7 finds the best five among seven', () => {
    const score = evaluate7(['2h', '9c', 'Ah', 'Kh', 'Qh', 'Jh', '3d']);
    expect(score >> 20).toBe(CATEGORY.flush);
    expect(describeHand(score)).toBe('Flush, Ace High');
  });
});

/* ------------------------------------------------------------------ */
/* redact.ts                                                          */
/* ------------------------------------------------------------------ */

describe('redact: view field fidelity', () => {
  it('choosing view carries exactly buttonSeat/dealerId/deadline (no botChooseAt)', () => {
    const t = new Table(2, {
      config: { enabledVariants: ['holdem', 'five-draw'] as VariantId[] },
    });
    t.start();
    expect(t.state.phase).toBe('choosing');
    const view = redactForPlayer(t.state, 'p0');
    expect(view.choosing).toEqual({
      buttonSeat: t.state.choosing!.buttonSeat,
      dealerId: t.state.choosing!.dealerId,
      deadline: t.state.choosing!.deadline,
    });
  });

  it('carryPot passes through and potTotal ADDS the communal pot', () => {
    const t = new Table(2);
    t.start();
    t.state.carryPot = 5;
    t.state.hand!.pot = 9;
    const committedSum = Object.values(t.state.hand!.totalCommitted).reduce((a, b) => a + b, 0);
    const view = redactForPlayer(t.state, 'p0');
    expect(view.carryPot).toBe(5);
    expect(view.hand!.potTotal).toBe(committedSum + 9);
  });

  it('per-street committed chips are mirrored into the view', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'bet', 5);
    const view = redactForPlayer(t.state, null);
    expect(view.hand!.committed).toEqual({ ...t.state.hand!.round.committed });
    expect(view.hand!.committed.p1).toBe(5);
  });

  it('legalActions stays null (and nothing throws) when nobody is to act', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'fold'); // hand-over: result exists, toAct null
    expect(t.state.hand!.round.toAct).toBeNull();
    expect(redactForPlayer(t.state, null).hand!.legalActions).toBeNull();
    expect(redactForPlayer(t.state, 'p0').hand!.legalActions).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* identity.ts                                                        */
/* ------------------------------------------------------------------ */

describe('identity: cookie header parsing', () => {
  it('skips malformed parts (no "=") and still finds the real cookie', () => {
    const token = signPlayerToken('u_1', 'g1');
    // 'hg_g1x' has no '=' and, minus its last char, collides with the cookie
    // name — only the `eq === -1` skip keeps it from short-circuiting.
    const req = new Request('http://x.test/', {
      headers: { cookie: `hg_g1x; other=1; hg_g1=${token}` },
    });
    expect(playerIdFromRequest(req, 'g1')).toBe('u_1');
  });
});
