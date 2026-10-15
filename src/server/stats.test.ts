import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getLegalActions } from '@/engine/betting';
import { Table, legalFor } from '@/engine/test-utils';
import type { GameState, VariantId } from '@/engine/types';
import { StatsView } from '@/components/StatsView';
import { MemoryKV } from './kv';
import { createMemoryStatsKV, setStatsKVForTests, statsKey, type StatsKV } from './stats-store';
import {
  LEADERBOARD_CAP,
  classifyMadeHand,
  extractStatsDelta,
  persistStatsDeltas,
  playerStatsKey,
  readStatsSnapshot,
  type StatsDelta,
} from './stats';
import { createNewGame, withGame } from './store';

function deal(variant: VariantId, n = 2): Table {
  const t = new Table(n, {
    config: { enabledVariants: [variant], ante: 1, minBet: 2, topUps: 0 },
  });
  t.start();
  expect(t.hand.variant).toBe(variant);
  return t;
}

/** Check, stand pat, pass, or flip until the hand leaves 'playing'. */
function playOut(t: Table): void {
  let guard = 0;
  while (t.state.phase === 'playing' && t.toAct) {
    if (guard++ > 200) throw new Error(`did not finish ${t.hand.variant}`);
    const id = t.toAct;
    if (t.hand.round.kind === 'exchange') {
      const legal = getLegalActions(t.state, id);
      const move = legal?.kind === 'exchange' ? legal.moves[0] : undefined;
      if (move?.kind === 'discard') {
        t.apply({ type: 'variantMove', playerId: id, move: { kind: 'discard', cardIndexes: [] } });
      } else if (move?.kind === 'aceCall') {
        t.apply({ type: 'variantMove', playerId: id, move: { kind: 'aceCall', high: false } });
      } else if (move?.kind === 'wager') {
        t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
      } else if (move?.kind === 'flip') {
        t.apply({ type: 'variantMove', playerId: id, move: { kind: 'flip' } });
      } else {
        throw new Error(`unhandled exchange ${move?.kind ?? 'none'}`);
      }
    } else {
      const legal = legalFor(t.state, id);
      t.act(id, legal.canCheck ? 'check' : 'call');
    }
  }
}

class RecordingKV implements StatsKV {
  keys: string[] = [];
  setnxCalls = 0;
  constructor(private inner: StatsKV) {}
  private note(key: string) {
    this.keys.push(key);
  }
  async incrBy(key: string, field: string, n: number) {
    this.note(key);
    return this.inner.incrBy(key, field, n);
  }
  async hset(key: string, fields: Record<string, string>) {
    this.note(key);
    return this.inner.hset(key, fields);
  }
  async hgetall(key: string) {
    this.note(key);
    return this.inner.hgetall(key);
  }
  async sadd(key: string, member: string) {
    this.note(key);
    return this.inner.sadd(key, member);
  }
  async smembers(key: string) {
    this.note(key);
    return this.inner.smembers(key);
  }
  async setnx(key: string, value: string) {
    this.note(key);
    this.setnxCalls++;
    return this.inner.setnx(key, value);
  }
}

async function award(prev: GameState, next: GameState, kv: StatsKV): Promise<StatsDelta> {
  const delta = extractStatsDelta(prev, next);
  expect(delta?.hand).toBeTruthy();
  await persistStatsDeltas([delta!], kv);
  return delta!;
}

describe('playerStatsKey', () => {
  it('trims and keeps the first 20 characters', () => {
    expect(playerStatsKey('  Alice The Very Long Name  ')).toBe('Alice The Very Long ');
    expect(playerStatsKey('Alice The Very Long Name!!')).toBe('Alice The Very Long ');
  });
});

describe('classifyMadeHand', () => {
  it('leaves baseball and in-between out of every made-hand chart', () => {
    const seven = ['As', 'Ad', '3s', '3h', '9c', 'Kh', '5h'];
    expect(classifyMadeHand('baseball', seven, [])).toBeUndefined();
    expect(classifyMadeHand('in-between', ['As', 'Kd'], [])).toBeUndefined();
    expect(classifyMadeHand('holdem', ['As', 'Ah'], ['Kd', 'Kc', 'Qh', 'Js', '3c'])?.game).toBe(
      'holdem'
    );
  });
});

describe('extractStatsDelta', () => {
  it('ignores a bet that does not award the hand', () => {
    const t = deal('holdem');
    const id = t.toAct!;
    const legal = legalFor(t.state, id);
    const prev = structuredClone(t.state);
    t.act(id, 'bet', legal.minRaiseTo);
    expect(extractStatsDelta(prev, t.state)).toBeNull();
    expect(t.totalChips()).toBe(40);
  });

  it('counts calls once, when the hand is awarded, and does not touch chips', async () => {
    const t = deal('holdem');
    const chips = t.totalChips();
    t.checkDownStreets(3);
    expect(t.hand.board).toHaveLength(5);
    const bettor = t.toAct!;
    t.act(bettor, 'bet', legalFor(t.state, bettor).minRaiseTo);
    const caller = t.toAct!;
    const prev = structuredClone(t.state);
    t.act(caller, 'call');
    expect(t.state.phase).toBe('hand-over');
    expect(t.totalChips()).toBe(chips);

    const frozen = structuredClone(t.state);
    const kv = createMemoryStatsKV();
    const delta = await award(prev, t.state, kv);
    expect(t.state).toEqual(frozen);
    expect(t.totalChips()).toBe(chips);

    const callerRow = delta.hand!.actors.find((a) => a.id === caller);
    const bettorRow = delta.hand!.actors.find((a) => a.id === bettor);
    expect(callerRow?.calls).toBe(1);
    expect(bettorRow?.calls).toBe(0);
    expect(delta.hand!.actors.every((a) => a.made?.game === 'holdem')).toBe(true);

    const snap = await readStatsSnapshot(kv);
    expect(snap.house.handsPlayed).toBe(1);
    expect(snap.house.variants.holdem).toBe(1);
    expect(snap.players.reduce((n, p) => n + p.calls, 0)).toBe(1);
    const madeSum = Object.values(snap.house.made.holdem ?? {}).reduce((a, b) => a + b, 0);
    expect(madeSum).toBe(2);
  });

  it('a fold-out increments the variant and not a made-hand bucket', async () => {
    const t = deal('holdem');
    const prev = structuredClone(t.state);
    t.act(t.toAct!, 'fold');
    expect(t.hand.result!.hands).toEqual({});
    const kv = createMemoryStatsKV();
    await award(prev, t.state, kv);
    const hash = await kv.hgetall(statsKey('house'));
    expect(hash.handsPlayed).toBe('1');
    expect(hash['v:holdem']).toBe('1');
    expect(Object.keys(hash).some((k) => k.startsWith('made:'))).toBe(false);
  });

  it('does not double-count the same fingerprint, including a CAS retry', async () => {
    const t = deal('holdem');
    const prev = structuredClone(t.state);
    t.act(t.toAct!, 'fold');
    const delta = extractStatsDelta(prev, t.state)!;
    const kv = createMemoryStatsKV();
    await persistStatsDeltas([delta], kv);
    await persistStatsDeltas([delta], kv);
    expect((await readStatsSnapshot(kv)).house.handsPlayed).toBe(1);
  });

  it('a rematch hand with a later timestamp counts again', async () => {
    const t = deal('holdem');
    const kv = createMemoryStatsKV();
    const beforeFirst = structuredClone(t.state);
    t.act(t.toAct!, 'fold');
    const firstDelta = await award(beforeFirst, t.state, kv);
    t.apply({ type: 'endGame', byId: 'p0' });
    t.apply({ type: 'playAgain', playerId: 'p0' });
    t.now += 5;
    t.start();
    const beforeSecond = structuredClone(t.state);
    t.act(t.toAct!, 'fold');
    const secondDelta = await award(beforeSecond, t.state, kv);
    expect(secondDelta.hand!.fingerprint).not.toBe(firstDelta.hand!.fingerprint);
    expect((await readStatsSnapshot(kv)).house.handsPlayed).toBe(2);
  });
});

describe('variant buckets', () => {
  it('baseball showdown does not increment hold\'em hand-kind buckets', async () => {
    // True showdown: both players stay in and the beaten hand is all-up,
    // so result.hands holds seven-card wild hands.
    const t = deal('baseball');
    for (const [id, cards] of Object.entries({
      p1: ['Kd', 'Qc', '2c', '4h', '5s', '7d', '8c'],
      p0: ['2s', '4c', '5c', '7h', '8s', 'Th', 'Kh'],
    })) {
      t.hand.playerCards[id] = { cards: [...cards], faceUp: cards.map(() => false) };
    }
    const flip = (id: string) =>
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'flip' } });
    const checkRound = () => {
      const street = t.hand.round.street;
      let guard = 0;
      while (t.state.phase === 'playing' && t.hand.round.kind === 'betting' && t.hand.round.street === street) {
        if (guard++ > 10) throw new Error('betting round did not close');
        const id = t.toAct!;
        t.act(id, legalFor(t.state, id).canCheck ? 'check' : 'call');
      }
    };
    flip('p1');
    checkRound();
    for (let i = 0; i < 7; i++) flip('p0');
    checkRound();
    flip('p1');
    checkRound();
    expect(t.state.phase).toBe('hand-over');
    expect(Object.keys(t.hand.result!.hands).length).toBeGreaterThan(0);
    expect(t.hand.result!.hands.p1).toHaveLength(7);
    const kv = createMemoryStatsKV();
    const dealt = structuredClone(t.state);
    dealt.hand!.result = null;
    await award(dealt, t.state, kv);
    const hash = await kv.hgetall(statsKey('house'));
    expect(hash['v:baseball']).toBe('1');
    expect(hash.handsPlayed).toBe('1');
    expect(Object.keys(hash).some((k) => k.includes('holdem'))).toBe(false);
    expect(Object.keys(hash).some((k) => k.startsWith('made:'))).toBe(false);
    expect((await readStatsSnapshot(kv)).house.made.holdem).toBeUndefined();
  });

  it('in-between counts the hand and not a pair or a flush', async () => {
    const t = deal('in-between');
    const chips = t.totalChips();
    const prev = structuredClone(t.state);
    playOut(t);
    expect(t.hand.variant).toBe('in-between');
    expect(t.hand.result!.hands).toEqual({});
    expect(t.totalChips()).toBe(chips);
    const frozen = structuredClone(t.state);
    const kv = createMemoryStatsKV();
    await award(prev, t.state, kv);
    expect(t.state).toEqual(frozen);
    const hash = await kv.hgetall(statsKey('house'));
    expect(hash['v:in-between']).toBe('1');
    expect(Object.keys(hash).some((k) => k.startsWith('made:'))).toBe(false);
    expect(hash.pair).toBeUndefined();
    expect(hash.flush).toBeUndefined();
    expect((await readStatsSnapshot(kv)).house.made.holdem).toBeUndefined();
  });

  it('stud, draw, and guts record their own evaluators', async () => {
    const kv = createMemoryStatsKV();
    for (const variant of ['seven-stud', 'five-draw', 'guts'] as const) {
      const t = deal(variant);
      const prev = structuredClone(t.state);
      playOut(t);
      expect(t.hand.result).toBeTruthy();
      expect(Object.keys(t.hand.result!.hands).length).toBeGreaterThan(0);
      await award(prev, t.state, kv);
    }
    const snap = await readStatsSnapshot(kv);
    expect(snap.house.variants['seven-stud']).toBe(1);
    expect(snap.house.variants['five-draw']).toBe(1);
    expect(snap.house.variants.guts).toBe(1);
    expect(snap.house.made.holdem).toBeUndefined();
    expect(Object.values(snap.house.made['seven-stud'] ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.values(snap.house.made['five-draw'] ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
    expect(Object.values(snap.house.made.guts ?? {}).reduce((a, b) => a + b, 0)).toBe(2);
    const gutsKinds = Object.keys(snap.house.made.guts ?? {});
    expect(gutsKinds.every((k) => k !== 'twoPair' && k !== 'fullHouse' && k !== 'quads')).toBe(
      true
    );
  });
});

describe('leaderboard', () => {
  it('caps the board at 15 and accumulates one trimmed name', async () => {
    const kv = createMemoryStatsKV();
    const deltas: StatsDelta[] = [];
    for (let i = 0; i < LEADERBOARD_CAP + 1; i++) {
      deltas.push({
        gameId: 'g',
        hand: {
          fingerprint: `h:g:${i}`,
          variant: 'holdem',
          actors: [
            {
              id: `p${i}`,
              name: `Player ${String(i).padStart(2, '0')}`,
              isBot: false,
              won: i < LEADERBOARD_CAP,
              calls: 0,
            },
          ],
        },
      });
    }
    deltas.push({
      gameId: 'g',
      hand: {
        fingerprint: 'h:g:alice-1',
        variant: 'guts',
        actors: [
          { id: 'a', name: '  Alice The Very Long Name  ', isBot: false, won: true, calls: 1 },
        ],
      },
    });
    deltas.push({
      gameId: 'g',
      hand: {
        fingerprint: 'h:g:alice-2',
        variant: 'guts',
        actors: [
          { id: 'b', name: 'Alice The Very Long Name!!', isBot: false, won: false, calls: 2 },
        ],
      },
    });
    await persistStatsDeltas(deltas, kv);
    const snap = await readStatsSnapshot(kv);
    expect(snap.players).toHaveLength(LEADERBOARD_CAP);
    expect(snap.players.some((p) => p.name === 'Player 15')).toBe(false);
    const alice = snap.players.find((p) => p.id === 'Alice The Very Long ');
    expect(alice).toMatchObject({ hands: 2, wins: 1, calls: 3 });
  });

  it('writes only dc:stats: keys', async () => {
    const kv = new RecordingKV(createMemoryStatsKV());
    const t = deal('holdem');
    const prev = structuredClone(t.state);
    t.act(t.toAct!, 'fold');
    await award(prev, t.state, kv);
    expect(kv.keys.length).toBeGreaterThan(0);
    for (const key of kv.keys) {
      expect(key.startsWith('dc:stats:')).toBe(true);
      expect(key.startsWith('stats:')).toBe(false);
      expect(key).not.toBe('stats:house');
      expect(key.startsWith('stats:player')).toBe(false);
    }
    expect(kv.setnxCalls).toBe(1);
  });
});

describe('withGame', () => {
  let recording: RecordingKV;

  beforeEach(() => {
    globalThis.__gameKV = new MemoryKV();
    recording = new RecordingKV(createMemoryStatsKV());
    setStatsKVForTests(recording);
  });

  afterEach(() => {
    globalThis.__gameKV = undefined;
    setStatsKVForTests(undefined);
  });

  async function foldOneHand(gameId: string, hostId: string) {
    await withGame(gameId, () => ({
      type: 'requestSeat',
      playerId: 'p1',
      name: 'Bea',
      seat: 1,
    }));
    await withGame(gameId, () => ({ type: 'approveSeat', byId: hostId, playerId: 'p1' }));
    await withGame(gameId, () => ({ type: 'startGame', byId: hostId }));
    const cur = await withGame(gameId);
    if (!cur.ok || !cur.state.hand?.round.toAct) throw new Error('expected a turn');
    const id = cur.state.hand.round.toAct;
    return withGame(gameId, () => ({ type: 'playerAction', playerId: id, move: 'fold' }));
  }

  it('records the awarded hand once and ignores a later idle read', async () => {
    const { gameId, hostId } = await createNewGame({
      hostName: 'Ada',
      config: { enabledVariants: ['holdem'] },
    });
    const folded = await foldOneHand(gameId, hostId);
    expect(folded.ok).toBe(true);
    expect(recording.setnxCalls).toBe(1);
    expect((await readStatsSnapshot()).house.handsPlayed).toBe(1);
    const idle = await withGame(gameId);
    expect(idle.ok).toBe(true);
    expect(recording.setnxCalls).toBe(1);
    expect((await readStatsSnapshot()).house.handsPlayed).toBe(1);
  });

  it('still returns the hand when the stats write throws', async () => {
    setStatsKVForTests({
      async incrBy() {
        throw new Error('stats down');
      },
      async hset() {
        throw new Error('stats down');
      },
      async hgetall() {
        return {};
      },
      async sadd() {
        throw new Error('stats down');
      },
      async smembers() {
        return [];
      },
      async setnx() {
        throw new Error('stats down');
      },
    });
    const { gameId, hostId } = await createNewGame({
      hostName: 'Ada',
      config: { enabledVariants: ['holdem'] },
    });
    const folded = await foldOneHand(gameId, hostId);
    expect(folded.ok).toBe(true);
    if (!folded.ok) return;
    expect(folded.state.hand?.result).toBeTruthy();
    expect(folded.state.phase).toBe('hand-over');
  });
});

describe('bot wins', () => {
  it('credits the bot that takes the last chips', async () => {
    const t = new Table(1, {
      config: { enabledVariants: ['holdem'], ante: 1, minBet: 2, topUps: 0, startingStack: 4 },
    });
    t.apply({ type: 'addBot', byId: 'p0' });
    t.start();
    const bot = Object.values(t.state.players).find((p) => p.isBot)!;
    t.rig(
      { p0: ['2c', '7d'], [bot.id]: ['As', 'Ah'] },
      ['Kd', 'Kc', 'Qh', 'Js', '3c']
    );
    const chips = t.totalChips();
    const prev = structuredClone(t.state);
    let guard = 0;
    while (t.state.phase === 'playing' && t.toAct) {
      if (guard++ > 10) throw new Error('all-in did not finish');
      const id = t.toAct;
      const legal = legalFor(t.state, id);
      if (legal.canBet) t.act(id, 'bet', legal.maxRaiseTo);
      else if (legal.callAmount > 0) t.act(id, 'call');
      else t.act(id, 'check');
    }
    expect(t.totalChips()).toBe(chips);
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('humansOut');
    const kv = new RecordingKV(createMemoryStatsKV());
    const delta = extractStatsDelta(prev, t.state)!;
    expect(delta.hand).toBeTruthy();
    expect(delta.gameEnd?.winnerId).toBe(bot.id);
    await persistStatsDeltas([delta], kv);
    expect(kv.setnxCalls).toBe(2);
    await persistStatsDeltas([delta], kv);
    const snap = await readStatsSnapshot(kv);
    expect(snap.house.handsPlayed).toBe(1);
    expect(snap.bots).toEqual([
      expect.objectContaining({ name: bot.name, gameWins: 1, wins: 1 }),
    ]);
    expect(snap.house.made.holdem).toBeTruthy();
  });
});

describe('StatsView', () => {
  it('says the same display name accumulates and has no frequency column', async () => {
    const kv = createMemoryStatsKV();
    await persistStatsDeltas(
      [
        {
          gameId: 'g',
          hand: {
            fingerprint: 'h:view',
            variant: 'holdem',
            actors: [
              {
                id: 'a',
                name: 'Ada',
                isBot: false,
                won: true,
                calls: 1,
                made: { game: 'holdem', kind: 'pair' },
              },
            ],
          },
        },
      ],
      kv
    );
    const html = renderToStaticMarkup(
      createElement(StatsView, { snapshot: await readStatsSnapshot(kv) })
    );
    expect(html).toContain('same display name');
    expect(html).toContain('Texas Hold');
    expect(html).toContain('Ada');
    expect(html).not.toContain('Expected');
    expect(html).not.toContain('frequency');
  });
});
