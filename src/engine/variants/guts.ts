import type { Card, ExchangeLegal, HandState, VariantMoveInput } from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import type { MoveError } from '../betting';
import { CATEGORY3, describe3, evaluate3 } from '../evaluator3';
import { active } from '../betting';

/**
 * Three-card guts: ante, three down cards, one check-or-bet round (house
 * rule 2026-08-01: a strong hand can sweeten what losers must match — a bet
 * must be called to earn the declare; folders are out), then one open
 * in-turn declare round (left of the dealer first). Everyone who stays is
 * IN; the best 3-card hand takes the pot and every other IN player matches
 * the pot into the NEXT hand's pot (table stakes — capped at their stack by
 * the engine).
 *
 * If all but one player drop — in the betting round or the declares — the
 * engine's fold-win fires the moment active() hits 1: the last player takes
 * the pot without ever declaring — the correct house outcome. That also
 * makes "everyone out" structurally impossible.
 *
 * Deck math: 6 players × 3 cards = 18 ≤ 52 — always fits.
 */

function declareLegal(): ExchangeLegal {
  return {
    kind: 'exchange',
    moves: [{ kind: 'declare' }],
    autoMove: { kind: 'declare', choice: 'out' }, // timeout = drop
  };
}

/**
 * Raw 0..1 strength of a 3-card guts hand. Category sets the band; the top
 * rank (and a whisker of the lower nibbles) orders hands within it.
 */
export function gutsStrength(cards: Card[]): number {
  const score = evaluate3(cards);
  const category = score >> 20;
  const r1 = (score >> 8) & 0xf;
  const withinBand = (r1 - 2) / 12; // 0..1 across ranks 2..14
  const fine = (score & 0xff) / 0xff / 60; // tie-break on kickers, tiny
  const base: Record<number, [number, number]> = {
    // [floor, span] per category.
    [CATEGORY3.highCard]: [0.03, 0.42],
    [CATEGORY3.pair]: [0.55, 0.22],
    [CATEGORY3.flush]: [0.8, 0.05],
    [CATEGORY3.straight]: [0.86, 0.05],
    [CATEGORY3.trips]: [0.92, 0.06],
    [CATEGORY3.straightFlush]: [0.99, 0.01],
  };
  const [floor, span] = base[category];
  return Math.min(1, floor + withinBand * span + fine);
}

export const guts: GameVariant = {
  id: 'guts',
  name: 'Three-Card Guts',
  marquee: '3-CARD GUTS',
  layoutHint: 'per-player',
  minPlayers: 2,
  fitsPlayers: (count) => count >= 2 && count <= 6,

  deal(v): PhasePlan {
    for (const id of v.hand.inHand) {
      const cards: Card[] = [];
      for (let i = 0; i < 3; i++) cards.push(v.draw());
      v.hand.playerCards[id] = { cards, faceUp: [false, false, false] };
    }
    return { kind: 'betting', street: 'bet' };
  },

  nextPhase(v): PhasePlan {
    // Betting closed → the declares; the declares closed → showdown among
    // the ≥2 IN players (a lone survivor already fold-won in the engine).
    if (v.hand.round.street === 'bet') return { kind: 'exchange', street: 'declare' };
    return { kind: 'showdown' };
  },

  score(hand: HandState, playerId: string): number {
    return evaluate3(hand.playerCards[playerId].cards);
  },
  describeScore: describe3,

  exchange: {
    // Everyone's declare turn looks the same; the engine has already checked
    // whose turn it is.
    legal(): ExchangeLegal {
      return declareLegal();
    },
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ): { applied: { move: string; detail?: unknown } } | { error: MoveError } {
      if (move.kind !== 'declare')
        return { error: { code: 'illegal-move', message: 'Expected an in/out declaration' } };
      if (move.choice !== 'in' && move.choice !== 'out')
        return { error: { code: 'illegal-move', message: 'Declare in or out' } };

      // Declarations are public as they happen, like a live table.
      const declared = (v.hand.vstate.declared ??= {}) as Record<string, 'in' | 'out'>;
      declared[playerId] = move.choice;
      if (move.choice === 'out' && !v.hand.folded.includes(playerId)) {
        v.hand.folded.push(playerId);
      }
      v.emit('declared', { playerId, choice: move.choice });
      return { applied: { move: `declare ${move.choice}`, detail: { choice: move.choice } } };
    },
  },

  /**
   * Pot matching: runs after the pot award, so the matched amount is exactly
   * what the winner just collected (antes + any carried fund). Every IN
   * player who did not win pays that into the next hand's pot; the engine
   * caps each payment at the player's stack. Fold-win hands (everyone
   * dropped) have no matchers.
   */
  settle(v): { payments: Record<string, number>; carry: number } | null {
    const hand = v.hand;
    const contenders = active(hand);
    if (contenders.length < 2 || !hand.result) return null; // fold-win — nothing to match
    const matched = hand.result.pots.reduce((a, p) => a + p.amount, 0);
    if (matched <= 0) return null;
    const winners = new Set(hand.result.pots.flatMap((p) => p.winners));
    const payments: Record<string, number> = {};
    for (const id of contenders) {
      if (!winners.has(id)) payments[id] = matched;
    }
    if (Object.keys(payments).length === 0) return null;
    return { payments, carry: 0 };
  },

  bot: {
    /**
     * The pre-declare betting round. Strength thresholds sit above the
     * declare threshold band: betting money also inflates what a losing
     * declare costs, so only clearly-winning hands push. Tuning knobs —
     * Stryker-excluded category, like every bot policy.
     */
    decideBet(view, randInt) {
      const legal = view.legal;
      if (legal.kind !== 'betting') return { move: 'check' };
      const strength = gutsStrength(view.hole);
      const p = view.personality;

      if (legal.canCheck) {
        // Flush-or-better bets; aggression widens the range a touch.
        const betAt = 0.8 - (p.aggression - 0.5) * 0.1;
        if (legal.canBet && strength >= betAt) {
          const target = Math.max(legal.minRaiseTo, Math.round(view.potTotal / 2));
          return { move: 'bet', amount: Math.min(legal.maxRaiseTo, target) };
        }
        return { move: 'check' };
      }

      // Facing a bet: continue only with a hand that will declare IN anyway.
      const price = legal.callAmount / Math.max(1, view.potTotal + legal.callAmount);
      const required = Math.min(
        0.9,
        0.45 + price * 0.4 + (p.tightness - 0.5) * 0.15 - (p.aggression - 0.5) * 0.1
      );
      if (strength < required) return { move: 'fold' };
      if (legal.canRaise && strength >= 0.92 && randInt(2) === 1) {
        return { move: 'raise', amount: legal.minRaiseTo };
      }
      return { move: 'call' };
    },
    /**
     * Declare IN when hand strength clears a threshold that scales with the
     * risk (the pot you'd have to match relative to your stack) and the
     * bot's personality. Deterministic: a pair+ is usually in, king-high is
     * the borderline zone.
     */
    decideExchange(view: BotView): VariantMoveInput {
      const strength = gutsStrength(view.hole);
      const risk = Math.min(1, view.potTotal / Math.max(1, view.stack));
      const p = view.personality;
      const threshold = Math.min(
        0.85,
        Math.max(0.05, 0.22 + risk * 0.4 + (p.tightness - 0.5) * 0.25 - (p.aggression - 0.5) * 0.2)
      );
      return { kind: 'declare', choice: strength >= threshold ? 'in' : 'out' };
    },
  },
};
