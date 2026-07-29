import type { Card } from './types';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'] as const;
export const SUITS = ['s', 'h', 'd', 'c'] as const;

/** Numeric rank value: 2..14 (A high). */
export function rankValue(card: Card): number {
  return RANKS.indexOf(card[0] as (typeof RANKS)[number]) + 2;
}

export function suitOf(card: Card): string {
  return card[1];
}

export function newDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(rank + suit);
    }
  }
  return deck;
}

export type RandInt = (maxExclusive: number) => number;

/**
 * Fisher-Yates shuffle. Uniform iff randInt is uniform — the server injects
 * crypto.randomInt (bias-free); tests inject a seeded PRNG.
 */
export function shuffle<T>(items: readonly T[], randInt: RandInt): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
