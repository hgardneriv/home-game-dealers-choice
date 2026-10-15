import { evaluate5, evaluate7 } from '@/engine/evaluator';
import { evaluate3 } from '@/engine/evaluator3';
import type { Card, GameEvent, GameState, HandState, VariantId } from '@/engine/types';
import { getStatsKV, statsKey, type StatsKV } from './stats-store';

/** Public leaderboard length. */
export const LEADERBOARD_CAP = 15;

const HOUSE_KEY = statsKey('house');
const BOTS_SET = statsKey('bots');
const PLAYERS_SET = statsKey('players');

function botHash(slug: string): string {
  return statsKey(`bot:${slug}`);
}
function playerHash(id: string): string {
  return statsKey(`player:${id}`);
}
function seenKey(fingerprint: string): string {
  return statsKey(`seen:${fingerprint}`);
}

/**
 * Leaderboard key is the display name — no accounts. The same trimmed name
 * accumulates, so two friends who pick it share one row.
 */
export function playerStatsKey(name: string): string {
  return name.trim().slice(0, 20);
}

export function botSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

/** Games whose showdown uses a standard (non-wild) evaluator. */
export type MadeGame = 'holdem' | 'seven-stud' | 'five-draw' | 'guts';

export const STANDARD_KINDS = [
  'highCard',
  'pair',
  'twoPair',
  'trips',
  'straight',
  'flush',
  'fullHouse',
  'quads',
  'straightFlush',
] as const;

export const GUTS_KINDS = [
  'highCard',
  'pair',
  'flush',
  'straight',
  'trips',
  'straightFlush',
] as const;

export type StandardKind = (typeof STANDARD_KINDS)[number];
export type GutsKind = (typeof GUTS_KINDS)[number];

export interface MadeHand {
  game: MadeGame;
  kind: string;
}

export interface HandActor {
  id: string;
  name: string;
  isBot: boolean;
  won: boolean;
  calls: number;
  made?: MadeHand;
}

export interface HandDelta {
  fingerprint: string;
  variant: VariantId;
  actors: HandActor[];
}

export interface GameEndDelta {
  fingerprint: string;
  winnerId: string | null;
  players: { id: string; name: string; isBot: boolean; seated: boolean }[];
}

/** One record per awarded hand (calls included) and/or a night ending. */
export interface StatsDelta {
  gameId: string;
  hand?: HandDelta;
  gameEnd?: GameEndDelta;
}

export interface HouseStats {
  handsPlayed: number;
  variants: Record<string, number>;
  /** made[game][kind] — never a single 7-card histogram. */
  made: Record<string, Record<string, number>>;
}

export interface PlayerStats {
  id: string;
  name: string;
  hands: number;
  wins: number;
  calls: number;
}

export interface BotStats {
  slug: string;
  name: string;
  hands: number;
  wins: number;
  calls: number;
  gameWins: number;
}

export interface StatsSnapshot {
  house: HouseStats;
  players: PlayerStats[];
  bots: BotStats[];
}

export function madeField(made: MadeHand): string {
  return `made:${made.game}:${made.kind}`;
}

function standardKind(score: number): StandardKind {
  const cat = score >> 20;
  return STANDARD_KINDS[cat] ?? 'highCard';
}

function gutsKind(score: number): GutsKind {
  const cat = score >> 20;
  return GUTS_KINDS[cat] ?? 'highCard';
}

/**
 * Made-hand bucket for a stayed hand. Baseball (wild 3s/9s) and in-between
 * (a spread bet) return undefined so they cannot land in a hold'em column.
 */
export function classifyMadeHand(
  variant: VariantId,
  cards: Card[] | undefined,
  board: Card[]
): MadeHand | undefined {
  if (!cards || cards.length === 0) return undefined;
  if (variant === 'holdem') {
    if (cards.length !== 2 || board.length !== 5) return undefined;
    return { game: 'holdem', kind: standardKind(evaluate7([...cards, ...board])) };
  }
  if (variant === 'seven-stud') {
    if (cards.length !== 7) return undefined;
    return { game: 'seven-stud', kind: standardKind(evaluate7(cards)) };
  }
  if (variant === 'five-draw') {
    if (cards.length !== 5) return undefined;
    return { game: 'five-draw', kind: standardKind(evaluate5(cards)) };
  }
  if (variant === 'guts') {
    if (cards.length !== 3) return undefined;
    return { game: 'guts', kind: gutsKind(evaluate3(cards)) };
  }
  return undefined;
}

function lastOfType(events: GameEvent[], type: string): GameEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === type) return events[i];
  }
  return undefined;
}

function isNewHandResult(prev: GameState, next: GameState): boolean {
  if (!next.hand?.result) return false;
  const nextEv = lastOfType(next.events, 'hand-result');
  const prevEv = prev.hand?.result ? lastOfType(prev.events, 'hand-result') : undefined;
  if (!nextEv) return !prev.hand?.result;
  if (!prevEv) return true;
  return nextEv.seq !== prevEv.seq || nextEv.at !== prevEv.at;
}

/** Calls from this hand only, counted when the hand is awarded. */
function callsThisHand(next: GameState): Record<string, number> {
  const counts: Record<string, number> = {};
  const events = next.events;
  let end = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'hand-result') {
      end = i;
      break;
    }
  }
  if (end < 0) return counts;
  for (let i = end - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'hand-started' || e.type === 'hand-result') break;
    if (e.type !== 'action') continue;
    const data = e.data as { playerId?: string; move?: string };
    if (data.move !== 'call' || !data.playerId) continue;
    counts[data.playerId] = (counts[data.playerId] ?? 0) + 1;
  }
  return counts;
}

function handFingerprint(state: GameState, hand: HandState, at: number, seq: number): string {
  return `h:${state.id}:${hand.handNo}:${hand.variant}:${at}:${seq}`;
}

function buildHandDelta(next: GameState): HandDelta | undefined {
  const hand = next.hand;
  if (!hand?.result) return undefined;
  const ev = lastOfType(next.events, 'hand-result');
  const calls = callsThisHand(next);
  const actors: HandActor[] = hand.inHand.map((id) => {
    const p = next.players[id];
    const won = hand.result!.pots.some((pot) => pot.winners.includes(id));
    const made = classifyMadeHand(hand.variant, hand.result!.hands[id], hand.board);
    return {
      id,
      name: p?.name ?? id,
      isBot: p?.isBot ?? false,
      won,
      calls: calls[id] ?? 0,
      made,
    };
  });
  return {
    fingerprint: handFingerprint(next, hand, ev?.at ?? next.updatedAt, ev?.seq ?? 0),
    variant: hand.variant,
    actors,
  };
}

function buildGameEnd(next: GameState): GameEndDelta {
  const ev = lastOfType(next.events, 'game-ended');
  const data = (ev?.data ?? {}) as { winnerId?: string | null };
  const winnerId = data.winnerId ?? null;
  const players = Object.values(next.players).map((p) => ({
    id: p.id,
    name: p.name,
    isBot: p.isBot,
    seated: p.seat !== null,
  }));
  return {
    fingerprint: `g:${next.id}:${ev?.at ?? next.updatedAt}:${ev?.seq ?? 0}:${next.endedReason ?? ''}:${winnerId ?? ''}`,
    winnerId,
    players,
  };
}

/**
 * Stats implied by one engine step. Null unless a hand was just awarded or
 * the night just ended — a call mid-hand writes nothing.
 */
export function extractStatsDelta(prev: GameState, next: GameState): StatsDelta | null {
  const hand = isNewHandResult(prev, next) ? buildHandDelta(next) : undefined;
  const gameEnd = prev.phase !== 'ended' && next.phase === 'ended' ? buildGameEnd(next) : undefined;
  if (!hand && !gameEnd) return null;
  return { gameId: next.id, hand, gameEnd };
}

function intField(hash: Record<string, string>, field: string): number {
  const n = Number(hash[field] ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function variantsFrom(hash: Record<string, string>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(hash)) {
    if (!k.startsWith('v:')) continue;
    out[k.slice(2)] = Number(v) || 0;
  }
  return out;
}

function madeFrom(hash: Record<string, string>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, v] of Object.entries(hash)) {
    if (!k.startsWith('made:')) continue;
    const rest = k.slice('made:'.length);
    const idx = rest.indexOf(':');
    if (idx <= 0) continue;
    const game = rest.slice(0, idx);
    const kind = rest.slice(idx + 1);
    if (!kind) continue;
    (out[game] ??= {})[kind] = Number(v) || 0;
  }
  return out;
}

function emptyHouse(): HouseStats {
  return { handsPlayed: 0, variants: {}, made: {} };
}

function houseFrom(hash: Record<string, string>): HouseStats {
  return {
    handsPlayed: intField(hash, 'handsPlayed'),
    variants: variantsFrom(hash),
    made: madeFrom(hash),
  };
}

async function bumpActor(
  kv: StatsKV,
  actor: { name: string; isBot: boolean },
  fields: Record<string, number>
): Promise<void> {
  if (actor.isBot) {
    const slug = botSlug(actor.name);
    if (!slug) return;
    await kv.sadd(BOTS_SET, slug);
    await kv.hset(botHash(slug), { name: actor.name, slug });
    for (const [field, n] of Object.entries(fields)) {
      await kv.incrBy(botHash(slug), field, n);
    }
    return;
  }
  const id = playerStatsKey(actor.name);
  if (!id) return;
  await kv.sadd(PLAYERS_SET, id);
  await kv.hset(playerHash(id), { name: id });
  for (const [field, n] of Object.entries(fields)) {
    await kv.incrBy(playerHash(id), field, n);
  }
}

async function persistHand(kv: StatsKV, delta: StatsDelta): Promise<void> {
  const hand = delta.hand;
  if (!hand) return;
  if (!(await kv.setnx(seenKey(hand.fingerprint), '1'))) return;
  await kv.incrBy(HOUSE_KEY, 'handsPlayed', 1);
  await kv.incrBy(HOUSE_KEY, `v:${hand.variant}`, 1);
  for (const actor of hand.actors) {
    if (actor.made) await kv.incrBy(HOUSE_KEY, madeField(actor.made), 1);
    await bumpActor(kv, actor, {
      hands: 1,
      wins: actor.won ? 1 : 0,
      calls: actor.calls,
    });
  }
}

async function persistGameEnd(kv: StatsKV, delta: StatsDelta): Promise<void> {
  const end = delta.gameEnd;
  if (!end) return;
  if (!(await kv.setnx(seenKey(end.fingerprint), '1'))) return;
  const winner = end.winnerId ? end.players.find((p) => p.id === end.winnerId) : undefined;
  for (const p of end.players) {
    if (!p.seated) continue;
    if (p.isBot) await bumpActor(kv, p, { gamesPlayed: 1 });
  }
  if (winner?.isBot) await bumpActor(kv, winner, { gameWins: 1 });
}

export async function persistStatsDeltas(
  deltas: StatsDelta[],
  kv: StatsKV = getStatsKV()
): Promise<void> {
  for (const delta of deltas) {
    await persistHand(kv, delta);
    await persistGameEnd(kv, delta);
  }
}

export async function readStatsSnapshot(kv: StatsKV = getStatsKV()): Promise<StatsSnapshot> {
  const houseHash = await kv.hgetall(HOUSE_KEY);
  const house = intField(houseHash, 'handsPlayed') ? houseFrom(houseHash) : emptyHouse();

  const botSlugs = await kv.smembers(BOTS_SET);
  const bots: BotStats[] = [];
  for (const slug of botSlugs) {
    const hash = await kv.hgetall(botHash(slug));
    const row: BotStats = {
      slug,
      name: hash.name || slug,
      hands: intField(hash, 'hands'),
      wins: intField(hash, 'wins'),
      calls: intField(hash, 'calls'),
      gameWins: intField(hash, 'gameWins'),
    };
    if (row.hands <= 0 && row.gameWins <= 0 && row.calls <= 0) continue;
    bots.push(row);
  }
  bots.sort(
    (a, b) => b.gameWins - a.gameWins || b.wins - a.wins || a.name.localeCompare(b.name)
  );

  const playerIds = await kv.smembers(PLAYERS_SET);
  const players: PlayerStats[] = [];
  for (const id of playerIds) {
    const hash = await kv.hgetall(playerHash(id));
    const row: PlayerStats = {
      id,
      name: hash.name || id,
      hands: intField(hash, 'hands'),
      wins: intField(hash, 'wins'),
      calls: intField(hash, 'calls'),
    };
    if (row.hands <= 0) continue;
    players.push(row);
  }
  players.sort(
    (a, b) => b.wins - a.wins || b.hands - a.hands || a.name.localeCompare(b.name)
  );
  return { house, players: players.slice(0, LEADERBOARD_CAP), bots };
}
