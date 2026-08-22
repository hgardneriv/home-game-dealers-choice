import type { Card, ExchangeLegal, HandState, VariantMoveInput } from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import { CATEGORY3, describe3, evaluate3 } from '../evaluator3';
import { rankValue, suitOf, type RandInt } from '../deck';
import { decideFromStrength } from '../bot';
import type { MoveError } from '../betting';

/**
 * Three-card guts: ante, three down cards, a betting round, one draw of up
 * to two cards, a second betting round, then showdown on the best 3-card
 * hand (straight flush > trips > straight > flush > pair > high card).
 *
 * Deck math: 6 players × 3 dealt + 6 × 2 worst-case draws = 30 ≤ 52, so the
 * deck always suffices and discards never need reshuffling.
 */

const MAX_DISCARDS = 2;

function drawLegal(): ExchangeLegal {
  return {
    kind: 'exchange',
    moves: [{ kind: 'discard', min: 0, max: MAX_DISCARDS }, { kind: 'fold' }],
    autoMove: { kind: 'discard', cardIndexes: [] }, // timeout = stand pat
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

/** Two ranks that could complete a 3-card straight if a connector lands. */
function isStraightish(a: number, b: number): boolean {
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  if (hi === lo) return false;
  if (hi - lo === 1 || hi - lo === 2) return true;
  return hi === 14 && (lo === 2 || lo === 3); // wheel pieces
}

/** Which cards a sane player throws away. Exported for direct testing. */
export function chooseDiscards(hole: Card[]): number[] {
  if (hole.length !== 3) return [];
  const category = evaluate3(hole) >> 20;
  if (category >= CATEGORY3.flush) return []; // made flush-or-better — stand pat

  const byRank = new Map<number, number[]>();
  hole.forEach((c, i) => {
    const v = rankValue(c);
    byRank.set(v, [...(byRank.get(v) ?? []), i]);
  });
  const groups = [...byRank.entries()].sort((a, b) => b[1].length - a[1].length || b[0] - a[0]);
  if (groups[0][1].length >= 2) {
    // Pair (trips already stood above): keep them, draw the kicker.
    const keep = new Set(groups[0][1]);
    return hole.map((_, i) => i).filter((i) => !keep.has(i));
  }

  // Two to a flush: draw the odd suit.
  const bySuit = new Map<string, number[]>();
  hole.forEach((c, i) => {
    const s = suitOf(c);
    bySuit.set(s, [...(bySuit.get(s) ?? []), i]);
  });
  for (const idxs of bySuit.values()) {
    if (idxs.length === 2) {
      const keep = new Set(idxs);
      return hole.map((_, i) => i).filter((i) => !keep.has(i));
    }
  }

  // Two to a straight: keep the highest connector pair, draw the odd card.
  const ranked = hole.map((c, i) => ({ v: rankValue(c), i }));
  let bestKeep: number[] | null = null;
  let bestHigh = 0;
  for (let a = 0; a < 3; a++) {
    for (let b = a + 1; b < 3; b++) {
      if (!isStraightish(ranked[a].v, ranked[b].v)) continue;
      const pairHigh = Math.max(ranked[a].v, ranked[b].v);
      if (pairHigh > bestHigh) {
        bestHigh = pairHigh;
        bestKeep = [ranked[a].i, ranked[b].i];
      }
    }
  }
  if (bestKeep) {
    const keep = new Set(bestKeep);
    return hole.map((_, i) => i).filter((i) => !keep.has(i));
  }

  // Nothing: keep the highest card, draw two.
  const high = ranked.reduce((a, b) => (b.v > a.v ? b : a));
  return hole.map((_, i) => i).filter((i) => i !== high.i);
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
    return { kind: 'betting', street: 'first' };
  },

  nextPhase(v): PhasePlan {
    switch (v.hand.round.street) {
      case 'first':
        return { kind: 'exchange', street: 'draw' };
      case 'draw':
        return { kind: 'betting', street: 'second' };
      default:
        return { kind: 'showdown' };
    }
  },

  score(hand: HandState, playerId: string): number {
    return evaluate3(hand.playerCards[playerId].cards);
  },
  describeScore: describe3,

  exchange: {
    legal(): ExchangeLegal {
      return drawLegal();
    },
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ): { applied: { move: string; detail?: unknown } } | { error: MoveError } {
      if (move.kind === 'fold') {
        if (!v.hand.folded.includes(playerId)) v.hand.folded.push(playerId);
        return { applied: { move: 'fold' } };
      }
      if (move.kind !== 'discard')
        return { error: { code: 'illegal-move', message: 'Expected a discard' } };
      const pc = v.hand.playerCards[playerId];
      const indexes = [...new Set(move.cardIndexes)];
      if (indexes.length !== move.cardIndexes.length)
        return { error: { code: 'bad-amount', message: 'Duplicate cards' } };
      if (indexes.length > MAX_DISCARDS)
        return { error: { code: 'bad-amount', message: `Discard at most ${MAX_DISCARDS}` } };
      if (indexes.some((i) => !Number.isInteger(i) || i < 0 || i >= pc.cards.length))
        return { error: { code: 'bad-amount', message: 'No such card' } };

      const thrown = indexes.map((i) => pc.cards[i]);
      const kept = pc.cards.filter((_, i) => !indexes.includes(i));
      const drawn: Card[] = [];
      for (let i = 0; i < thrown.length; i++) drawn.push(v.draw());
      v.hand.discards.push(...thrown);
      pc.cards = [...kept, ...drawn];
      pc.faceUp = pc.cards.map(() => false);

      v.emit('cards-drawn', { playerId, count: thrown.length });
      return { applied: { move: thrown.length === 0 ? 'stand pat' : 'draw', detail: { count: thrown.length } } };
    },
  },

  bot: {
    decideBet(view: BotView, randInt: RandInt) {
      return decideFromStrength(view, randInt, gutsStrength(view.hole));
    },
    decideExchange(view: BotView): VariantMoveInput {
      return { kind: 'discard', cardIndexes: chooseDiscards(view.hole) };
    },
  },
};
