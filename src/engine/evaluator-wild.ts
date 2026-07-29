import type { Card } from './types';
import { rankValue, suitOf } from './deck';
import { CATEGORY, describe, evaluate5 } from './evaluator';

/**
 * Wild-card hand evaluation for baseball: 3s and 9s are wild. Uses the same
 * packing scheme as evaluator.ts — (category << 20) | five 4-bit kickers in
 * significance order — with one extra category above straight flush:
 * five of a kind. A wild may stand for any card, duplicates included (that is
 * what makes five of a kind possible), so e.g. two wilds in a flush both play
 * as aces.
 *
 * Handles 0..7 cards: partial hands (the visible boards of a no-peek flip
 * race) evaluate to the best pair/trips/quads ladder the wilds can complete;
 * 6 or 7 cards evaluate as the best 5-card selection.
 */

export const FIVE_OF_A_KIND = 9;

export function isWild(card: Card): boolean {
  const v = rankValue(card);
  return v === 3 || v === 9;
}

function pack(category: number, kickers: number[]): number {
  let score = category << 20;
  for (let i = 0; i < 5; i++) {
    score |= (kickers[i] ?? 0) << (16 - 4 * i);
  }
  return score;
}

/** [rank, count] pairs sorted by count desc, then rank desc. */
function rankGroups(values: number[]): [number, number][] {
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
}

/**
 * Highest straight the distinct natural ranks can anchor with wilds filling
 * the gaps (the five cards under evaluation are fixed — every natural must sit
 * inside the window). 0 when none. Handles the wheel (A,5,4,3,2).
 */
function wildStraightHigh(naturalRanks: number[]): number {
  for (let high = 14; high >= 6; high--) {
    if (naturalRanks.every((v) => v <= high && v >= high - 4)) return high;
  }
  if (naturalRanks.every((v) => v === 14 || (v >= 2 && v <= 5))) return 5;
  return 0;
}

/** Score exactly 5 cards with 3s/9s wild. Category-descending search. */
function evalWild5(cards: Card[]): number {
  const wilds = cards.filter(isWild).length;
  if (wilds === 0) return evaluate5(cards);
  const nats = cards.filter((c) => !isWild(c));
  if (nats.length === 0) return pack(FIVE_OF_A_KIND, [14]);

  const values = nats.map(rankValue).sort((a, b) => b - a);
  const groups = rankGroups(values);
  const distinct = groups.length === nats.length;
  const oneSuit = nats.every((c) => suitOf(c) === suitOf(nats[0]));

  // Five of a kind: every natural shares one rank; wilds complete it.
  if (groups.length === 1) return pack(FIVE_OF_A_KIND, [groups[0][0]]);

  // Straight flush.
  if (oneSuit && distinct) {
    const high = wildStraightHigh(values);
    if (high) return pack(CATEGORY.straightFlush, [high]);
  }

  // Quads: all naturals but one share a rank and the wilds complete four.
  // (A spare wild would have made five of a kind — already handled.)
  for (const [rank, count] of groups) {
    if (count + wilds >= 4 && nats.length - count === 1) {
      const kicker = values.find((v) => v !== rank)!;
      return pack(CATEGORY.quads, [rank, kicker]);
    }
  }

  // Full house: only two natural pairs + one wild lands here (any other wild
  // count upgrades to quads or better).
  if (wilds === 1 && groups.length === 2 && groups[0][1] === 2 && groups[1][1] === 2) {
    return pack(CATEGORY.fullHouse, [groups[0][0], groups[1][0]]);
  }

  // Flush: wilds play as aces.
  if (oneSuit) {
    const kickers = [...Array<number>(wilds).fill(14), ...values].sort((a, b) => b - a);
    return pack(CATEGORY.flush, kickers);
  }

  // Straight.
  if (distinct) {
    const high = wildStraightHigh(values);
    if (high) return pack(CATEGORY.straight, [high]);
  }

  // Trips: highest rank the wilds complete to three.
  let tripRank = 0;
  for (const [rank, count] of groups) {
    if (count + wilds >= 3 && rank > tripRank) tripRank = rank;
  }
  if (tripRank) {
    return pack(CATEGORY.trips, [tripRank, ...values.filter((v) => v !== tripRank)]);
  }

  // Reaching here means one wild and all-distinct naturals: pair the highest.
  return pack(CATEGORY.pair, [values[0], ...values.slice(1)]);
}

/** Best partial hand for 1..4 cards — the n-of-a-kind ladder with wilds. */
function evalWildPartial(cards: Card[]): number {
  if (cards.length === 0) return 0;
  const wilds = cards.filter(isWild).length;
  const nats = cards.filter((c) => !isWild(c));
  if (nats.length === 0) {
    // All wild: n aces.
    const cat = [CATEGORY.highCard, CATEGORY.pair, CATEGORY.trips, CATEGORY.quads][wilds - 1];
    return pack(cat, [14]);
  }

  const values = nats.map(rankValue).sort((a, b) => b - a);
  const groups = rankGroups(values);

  if (wilds === 0) {
    if (groups[0][1] === 4) return pack(CATEGORY.quads, [groups[0][0]]);
    if (groups[0][1] === 3)
      return pack(CATEGORY.trips, [groups[0][0], ...values.filter((v) => v !== groups[0][0])]);
    if (groups[0][1] === 2 && groups[1]?.[1] === 2)
      return pack(CATEGORY.twoPair, [groups[0][0], groups[1][0]]);
    if (groups[0][1] === 2)
      return pack(CATEGORY.pair, [groups[0][0], ...values.filter((v) => v !== groups[0][0])]);
    return pack(CATEGORY.highCard, values);
  }

  // Quads: all four cards one effective rank.
  if (groups.length === 1 && nats.length + wilds >= 4) return pack(CATEGORY.quads, [groups[0][0]]);
  // Trips: highest rank the wilds complete to three.
  let tripRank = 0;
  for (const [rank, count] of groups) {
    if (count + wilds >= 3 && rank > tripRank) tripRank = rank;
  }
  if (tripRank) {
    return pack(CATEGORY.trips, [tripRank, ...values.filter((v) => v !== tripRank)]);
  }
  // One wild left over: pair the highest natural.
  return pack(CATEGORY.pair, [values[0], ...values.slice(1)]);
}

/** Score 0..7 cards, wilds included; higher wins. 0 = no cards. */
export function evaluateWild(cards: Card[]): number {
  const n = cards.length;
  if (n < 5) return evalWildPartial(cards);
  if (n === 5) return evalWild5(cards);
  // Best 5-card selection from 6+.
  let best = 0;
  const five: Card[] = [];
  const choose = (start: number, need: number): void => {
    if (need === 0) {
      const score = evalWild5(five);
      if (score > best) best = score;
      return;
    }
    for (let i = start; i <= n - need; i++) {
      five.push(cards[i]);
      choose(i + 1, need - 1);
      five.pop();
    }
  };
  choose(0, 5);
  return best;
}

/** True when visible hand `a` STRICTLY beats visible hand `b`. */
export function beatsVisible(a: Card[], b: Card[]): boolean {
  return evaluateWild(a) > evaluateWild(b);
}

const PLURALS: Record<number, string> = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens',
  8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens',
  13: 'Kings', 14: 'Aces',
};

/** Human description; adds five of a kind above the standard vocabulary. */
export function describeWild(score: number): string {
  if (score >> 20 === FIVE_OF_A_KIND) {
    return `Five of a Kind, ${PLURALS[(score >> 16) & 0xf]}`;
  }
  return describe(score);
}
