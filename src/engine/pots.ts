import type { HandState } from './types';

export interface BuiltPots {
  /** Uncalled excess returned to its bettor before pots were built. */
  refunds: Record<string, number>;
  /** Main pot first, then side pots. Eligible = contributed to the layer and not folded. */
  pots: { amount: number; eligible: string[] }[];
}

/**
 * Construct main/side pots from whole-hand contributions.
 *
 * 1. Refund any uncalled excess: at most one player can have contributed more
 *    than every other player's total — the surplus goes back to them.
 * 2. Layer pots at each distinct contribution level of the non-folded players
 *    (ascending). Folded players' chips fall into the layers they reached but
 *    they are never eligible to win.
 */
export function buildPots(hand: HandState): BuiltPots {
  const totals: Record<string, number> = { ...hand.totalCommitted };
  const refunds: Record<string, number> = {};

  const ids = hand.inHand.filter((id) => (totals[id] ?? 0) > 0);
  if (ids.length === 0) return { refunds, pots: [] };

  // 1. Uncalled excess.
  const sorted = [...ids].sort((a, b) => (totals[b] ?? 0) - (totals[a] ?? 0));
  const top = sorted[0];
  const secondMax = sorted.length > 1 ? totals[sorted[1]] ?? 0 : 0;
  const excess = (totals[top] ?? 0) - secondMax;
  if (excess > 0) {
    refunds[top] = excess;
    totals[top] = secondMax;
  }

  // 2. Layered pots.
  const contesting = ids.filter((id) => !hand.folded.includes(id));
  const levels = [...new Set(contesting.map((id) => totals[id] ?? 0))]
    .filter((v) => v > 0)
    .sort((a, b) => a - b);

  const pots: { amount: number; eligible: string[] }[] = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    for (const id of ids) {
      amount += Math.max(0, Math.min(totals[id] ?? 0, level) - prev);
    }
    const eligible = contesting.filter((id) => (totals[id] ?? 0) >= level);
    if (amount > 0) pots.push({ amount, eligible });
    prev = level;
  }

  // Folded chips above the top contesting level are dead money with no layer
  // of their own. Unreachable in pure betting games (someone always remains
  // at the top level), but baseball's bust-out folds a player who ran out of
  // cards even while all-in. Bet and forfeited → the top pot, never dropped.
  let dead = 0;
  for (const id of ids) dead += Math.max(0, (totals[id] ?? 0) - prev);
  if (dead > 0) {
    if (pots.length > 0) pots[pots.length - 1].amount += dead;
    else pots.push({ amount: dead, eligible: contesting });
  }
  return { refunds, pots };
}
