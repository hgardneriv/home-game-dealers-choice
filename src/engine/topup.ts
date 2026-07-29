import type { TableConfig } from './types';

/**
 * Chips granted by a player's next top-up, or 0 when none remains — exhausted,
 * disabled, legacy game with no top-up config, or decayed below one big blind
 * (a stack that can't even post the BB is dead on arrival).
 *
 * First top-up is 60% of the buy-in; each later one shrinks by topUpDecayPct.
 * Every amount is computed from the (rounded) first — not iteratively
 * re-rounded — so the schedule is exactly reproducible from config alone.
 *
 * Pure and dependency-free: shared by the engine (validation), the sweep
 * (bot auto-rebuy), and the client UI (the "Top up $X" button), the same way
 * getLegalActions keeps server and ActionBar in agreement.
 */
export function topUpAmount(config: TableConfig, topUpsUsed: number): number {
  const max = config.topUps ?? 0; // legacy persisted games: feature off
  const used = topUpsUsed ?? 0;
  if (max <= 0 || used >= max) return 0;
  const first = Math.round(0.6 * config.startingStack);
  const decay = 1 - (config.topUpDecayPct ?? 50) / 100;
  const amount = Math.round(first * Math.pow(decay, used));
  return amount >= config.bigBlind ? amount : 0;
}
