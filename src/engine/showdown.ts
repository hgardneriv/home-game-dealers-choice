import type { Card, HandResult, HandState } from './types';
import { buildPots } from './pots';
import { active } from './betting';

/**
 * Resolve a hand that reached showdown (>=2 players not folded). Scoring is
 * the variant's business — the engine passes the variant's score/describe
 * functions in. Computes pots, winners, reveal order and auto-mucks, and
 * returns both the result and the per-player payouts (refunds + pot shares).
 * Does not mutate anything — the engine applies the payouts.
 */
export function resolveShowdown(
  hand: HandState,
  score: (hand: HandState, playerId: string) => number,
  describeScore: (score: number) => string
): { result: HandResult; payouts: Record<string, number> } {
  const contesting = active(hand);
  const { refunds, pots } = buildPots(hand);

  const scores: Record<string, number> = {};
  for (const id of contesting) {
    scores[id] = score(hand, id);
  }

  // Clockwise-from-left-of-button ordering — used for odd chips and reveals.
  const clockwise = (ids: string[]): string[] =>
    hand.inHand.filter((id) => ids.includes(id));

  // Reveal order: last aggressor of the final betting round shows first,
  // otherwise first player left of the button; then clockwise.
  const aggressor =
    hand.round.lastAggressor && contesting.includes(hand.round.lastAggressor)
      ? hand.round.lastAggressor
      : null;
  const baseOrder = clockwise(contesting);
  const start = aggressor ? baseOrder.indexOf(aggressor) : 0;
  const showdownOrder = baseOrder.map((_, i) => baseOrder[(start + i) % baseOrder.length]);

  // Reveal / auto-muck: show a hand only if it beats or ties every hand shown
  // so far for some pot it is eligible in. Winners always end up revealed.
  const bestShown: number[] = pots.map(() => 0);
  const revealed: Record<string, Card[]> = {};
  for (const id of showdownOrder) {
    let shows = false;
    pots.forEach((pot, i) => {
      if (pot.eligible.includes(id) && scores[id] >= bestShown[i]) shows = true;
    });
    if (contesting.length === 1) shows = false; // uncontested — no reveal needed
    if (shows) {
      revealed[id] = [...hand.playerCards[id].cards];
      pots.forEach((pot, i) => {
        if (pot.eligible.includes(id)) bestShown[i] = Math.max(bestShown[i], scores[id]);
      });
    }
  }

  const payouts: Record<string, number> = { ...refunds };
  const resultPots: HandResult['pots'] = [];
  for (const pot of pots) {
    const best = Math.max(...pot.eligible.map((id) => scores[id]));
    const winners = clockwise(pot.eligible.filter((id) => scores[id] === best));
    const base = Math.floor(pot.amount / winners.length);
    let remainder = pot.amount - base * winners.length;
    for (const id of winners) {
      // Odd chip(s) go to the first winner(s) clockwise from the button.
      const share = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder--;
      payouts[id] = (payouts[id] ?? 0) + share;
    }
    resultPots.push({ amount: pot.amount, winners, eligible: pot.eligible });
  }

  const descriptions: Record<string, string> = {};
  for (const id of Object.keys(revealed)) descriptions[id] = describeScore(scores[id]);

  return {
    result: { pots: resultPots, revealed, descriptions, showdownOrder, refunds },
    payouts,
  };
}

/** Resolve a hand won without showdown (everyone else folded). */
export function resolveFoldWin(
  hand: HandState
): { result: HandResult; payouts: Record<string, number> } {
  const winner = active(hand)[0];
  const total = Object.values(hand.totalCommitted).reduce((a, b) => a + b, 0);
  return {
    result: {
      pots: [{ amount: total, winners: [winner], eligible: [winner] }],
      revealed: {},
      descriptions: {},
      showdownOrder: [],
      refunds: {},
    },
    payouts: { [winner]: total },
  };
}
