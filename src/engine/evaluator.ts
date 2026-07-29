import type { Card } from './types';
import { rankValue, suitOf } from './deck';

/**
 * 5- and 7-card hand evaluation. A hand scores to a single integer where
 * higher = better: (category << 20) | five 4-bit kickers in significance
 * order. Rank values 2..14 fit a nibble; unused kicker slots are 0.
 */

export const CATEGORY = {
  highCard: 0,
  pair: 1,
  twoPair: 2,
  trips: 3,
  straight: 4,
  flush: 5,
  fullHouse: 6,
  quads: 7,
  straightFlush: 8,
} as const;

function pack(category: number, kickers: number[]): number {
  let score = category << 20;
  for (let i = 0; i < 5; i++) {
    score |= (kickers[i] ?? 0) << (16 - 4 * i);
  }
  return score;
}

/** High card of a straight if `ranks` (sorted desc, unique) form one, else 0. Handles the wheel. */
function straightHigh(ranks: number[]): number {
  if (ranks.length !== 5) return 0;
  if (ranks[0] - ranks[4] === 4) return ranks[0];
  // Wheel: A,5,4,3,2 — plays as five-high.
  if (ranks[0] === 14 && ranks[1] === 5 && ranks[1] - ranks[4] === 3) return 5;
  return 0;
}

/** Score exactly 5 cards. */
export function evaluate5(cards: Card[]): number {
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Group ranks by count desc, then rank desc — the significance order for kickers.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const uniqueDesc = [...counts.keys()].sort((a, b) => b - a);

  const sHigh = counts.size === 5 ? straightHigh(uniqueDesc) : 0;

  if (isFlush && sHigh) return pack(CATEGORY.straightFlush, [sHigh]);
  if (groups[0][1] === 4) return pack(CATEGORY.quads, [groups[0][0], groups[1][0]]);
  if (groups[0][1] === 3 && groups[1][1] === 2)
    return pack(CATEGORY.fullHouse, [groups[0][0], groups[1][0]]);
  if (isFlush) return pack(CATEGORY.flush, values);
  if (sHigh) return pack(CATEGORY.straight, [sHigh]);
  if (groups[0][1] === 3)
    return pack(CATEGORY.trips, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2 && groups[1][1] === 2)
    return pack(CATEGORY.twoPair, [groups[0][0], groups[1][0], groups[2][0]]);
  if (groups[0][1] === 2)
    return pack(CATEGORY.pair, [groups[0][0], groups[1][0], groups[2][0], groups[3][0]]);
  return pack(CATEGORY.highCard, values);
}

/** Best 5-card score from 7 cards (best of the 21 combinations). */
export function evaluate7(cards: Card[]): number {
  if (cards.length !== 7) throw new Error(`evaluate7 needs 7 cards, got ${cards.length}`);
  let best = 0;
  // Choose 5 of 7 = drop 2: iterate excluded pair (i, j).
  for (let i = 0; i < 7; i++) {
    for (let j = i + 1; j < 7; j++) {
      const five: Card[] = [];
      for (let k = 0; k < 7; k++) {
        if (k !== i && k !== j) five.push(cards[k]);
      }
      const score = evaluate5(five);
      if (score > best) best = score;
    }
  }
  return best;
}

const RANK_NAMES: Record<number, [string, string]> = {
  2: ['Two', 'Twos'], 3: ['Three', 'Threes'], 4: ['Four', 'Fours'],
  5: ['Five', 'Fives'], 6: ['Six', 'Sixes'], 7: ['Seven', 'Sevens'],
  8: ['Eight', 'Eights'], 9: ['Nine', 'Nines'], 10: ['Ten', 'Tens'],
  11: ['Jack', 'Jacks'], 12: ['Queen', 'Queens'], 13: ['King', 'Kings'],
  14: ['Ace', 'Aces'],
};

function name(v: number): string {
  return RANK_NAMES[v][0];
}
function plural(v: number): string {
  return RANK_NAMES[v][1];
}

/** Human description of a score, e.g. 'Two Pair, Aces and Eights'. */
export function describe(score: number): string {
  const category = score >> 20;
  const k = [0, 1, 2, 3, 4].map((i) => (score >> (16 - 4 * i)) & 0xf);
  switch (category) {
    case CATEGORY.straightFlush:
      return k[0] === 14 ? 'Royal Flush' : `Straight Flush, ${name(k[0])} High`;
    case CATEGORY.quads:
      return `Four of a Kind, ${plural(k[0])}`;
    case CATEGORY.fullHouse:
      return `Full House, ${plural(k[0])} over ${plural(k[1])}`;
    case CATEGORY.flush:
      return `Flush, ${name(k[0])} High`;
    case CATEGORY.straight:
      return `Straight, ${name(k[0])} High`;
    case CATEGORY.trips:
      return `Three of a Kind, ${plural(k[0])}`;
    case CATEGORY.twoPair:
      return `Two Pair, ${plural(k[0])} and ${plural(k[1])}`;
    case CATEGORY.pair:
      return `Pair of ${plural(k[0])}`;
    default:
      return `High Card ${name(k[0])}`;
  }
}
