import type { Card } from './types';
import { rankValue, suitOf } from './deck';

/**
 * Three-card hand evaluation for guts. A hand scores to a single integer where
 * higher = better: (category << 20) | (r1 << 8) | (r2 << 4) | r3, with the
 * three rank nibbles in significance order for the category. Rank values
 * 2..14 fit a nibble; unused slots are 0. The ordering only needs to be
 * self-consistent — it never mixes with the 5-card evaluator's scores.
 *
 * Three-card rankings (high to low): straight flush > trips > straight >
 * flush > pair > high card. A-2-3 is the low straight (plays three-high);
 * Q-K-A is the top.
 */

export const CATEGORY3 = {
  highCard: 0,
  pair: 1,
  flush: 2,
  straight: 3,
  trips: 4,
  straightFlush: 5,
} as const;

function pack3(category: number, r1: number, r2 = 0, r3 = 0): number {
  return (category << 20) | (r1 << 8) | (r2 << 4) | r3;
}

/** High card of a 3-card straight if `ranks` (sorted desc, unique) form one, else 0. */
function straightHigh3(ranks: number[]): number {
  if (ranks.length !== 3) return 0;
  if (ranks[0] - ranks[2] === 2) return ranks[0];
  // The wheel: A,3,2 — plays as three-high.
  if (ranks[0] === 14 && ranks[1] === 3 && ranks[2] === 2) return 3;
  return 0;
}

/** Score exactly 3 cards. Bigger wins. */
export function evaluate3(cards: Card[]): number {
  if (cards.length !== 3) throw new Error(`evaluate3 needs 3 cards, got ${cards.length}`);
  const values = cards.map(rankValue).sort((a, b) => b - a);
  const isFlush = cards.every((c) => suitOf(c) === suitOf(cards[0]));

  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const uniqueDesc = [...counts.keys()].sort((a, b) => b - a);
  const sHigh = counts.size === 3 ? straightHigh3(uniqueDesc) : 0;

  if (isFlush && sHigh) return pack3(CATEGORY3.straightFlush, sHigh);
  if (counts.size === 1) return pack3(CATEGORY3.trips, values[0]);
  if (sHigh) return pack3(CATEGORY3.straight, sHigh);
  if (isFlush) return pack3(CATEGORY3.flush, values[0], values[1], values[2]);
  if (counts.size === 2) {
    // One pair: pair rank first, then the kicker.
    const pairRank = uniqueDesc.find((v) => counts.get(v) === 2)!;
    const kicker = uniqueDesc.find((v) => counts.get(v) === 1)!;
    return pack3(CATEGORY3.pair, pairRank, kicker);
  }
  return pack3(CATEGORY3.highCard, values[0], values[1], values[2]);
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

/** Human description of a 3-card score, e.g. 'Pair of Nines'. */
export function describe3(score: number): string {
  const category = score >> 20;
  const r1 = (score >> 8) & 0xf;
  switch (category) {
    case CATEGORY3.straightFlush:
      return `Straight Flush, ${name(r1)} High`;
    case CATEGORY3.trips:
      return `Three of a Kind, ${plural(r1)}`;
    case CATEGORY3.straight:
      return `Straight, ${name(r1)} High`;
    case CATEGORY3.flush:
      return `Flush, ${name(r1)} High`;
    case CATEGORY3.pair:
      return `Pair of ${plural(r1)}`;
    default:
      return `High Card ${name(r1)}`;
  }
}
