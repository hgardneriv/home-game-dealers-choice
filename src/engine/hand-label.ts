import type { Card, VariantId } from './types';
import { rankValue } from './deck';
import { describe, evaluate5, CATEGORY } from './evaluator';
import { describeWild, evaluateWild } from './evaluator-wild';
import { describe3, evaluate3 } from './evaluator3';

/**
 * Live "what do these cards make" labels for the table UI — the casino-machine
 * courtesy of naming any made hand as it develops ("Pair of Kings",
 * "Three of a Kind, Aces"). Pure and client-safe: callers pass only cards a
 * player is entitled to see (their own view, or an opponent's face-up cards),
 * so nothing here can leak — it just describes.
 *
 * Returns null when the cards make nothing worth announcing (high card) or
 * the variant has no meaningful live label (in-between).
 */

const PLURALS: Record<number, string> = {
  2: 'Twos', 3: 'Threes', 4: 'Fours', 5: 'Fives', 6: 'Sixes', 7: 'Sevens',
  8: 'Eights', 9: 'Nines', 10: 'Tens', 11: 'Jacks', 12: 'Queens',
  13: 'Kings', 14: 'Aces',
};

/** Best 5-card score from 5, 6, or 7 cards. */
function bestOf(cards: Card[]): number {
  if (cards.length === 5) return evaluate5(cards);
  let best = 0;
  const five: Card[] = [];
  const choose = (start: number, need: number): void => {
    if (need === 0) {
      const score = evaluate5(five);
      if (score > best) best = score;
      return;
    }
    for (let i = start; i <= cards.length - need; i++) {
      five.push(cards[i]);
      choose(i + 1, need - 1);
      five.pop();
    }
  };
  choose(0, 5);
  return best;
}

/** Made groups in 2–4 cards (no straights/flushes possible yet). */
function partialLabel(cards: Card[]): string | null {
  const counts = new Map<number, number>();
  for (const c of cards) {
    const v = rankValue(c);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const [rank, count] = groups[0];
  if (count === 4) return `Four of a Kind, ${PLURALS[rank]}`;
  if (count === 3) return `Three of a Kind, ${PLURALS[rank]}`;
  if (count === 2 && groups[1]?.[1] === 2)
    return `Two Pair, ${PLURALS[rank]} and ${PLURALS[groups[1][0]]}`;
  if (count === 2) return `Pair of ${PLURALS[rank]}`;
  return null;
}

/** describe() the score, or null when it's just high card. */
function madeOrNull(score: number, describeFn: (s: number) => string): string | null {
  return score >> 20 > CATEGORY.highCard ? describeFn(score) : null;
}

/**
 * Label the hand `cards` make in `variant` (plus the community `board` where
 * the variant has one). `cards` is whatever the viewer may see: your own
 * cards for yourself, an opponent's face-up cards for everyone else.
 */
export function handLabel(variant: VariantId, cards: Card[], board: Card[] = []): string | null {
  if (cards.length === 0) return null;
  switch (variant) {
    case 'holdem': {
      const all = [...cards, ...board];
      if (all.length >= 5) return madeOrNull(bestOf(all.slice(0, 7)), describe);
      return partialLabel(all);
    }
    case 'seven-stud': {
      if (cards.length >= 5) return madeOrNull(bestOf(cards), describe);
      return partialLabel(cards);
    }
    case 'five-draw':
      return cards.length === 5 ? madeOrNull(evaluate5(cards), describe) : partialLabel(cards);
    case 'guts':
      return cards.length === 3 ? madeOrNull(evaluate3(cards), describe3) : null;
    case 'baseball':
      // Wild-aware for any 1..7 visible cards (0 stays null above).
      return madeOrNull(evaluateWild(cards), describeWild);
    default:
      // in-between (and anything future without a hand concept).
      return null;
  }
}
