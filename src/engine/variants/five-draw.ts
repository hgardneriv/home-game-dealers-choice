import type { Card, ExchangeLegal, HandState, VariantMoveInput } from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import { CATEGORY, describe, evaluate5 } from '../evaluator';
import { rankValue, suitOf, type RandInt } from '../deck';
import { decideFromStrength } from '../bot';
import type { MoveError } from '../betting';

/**
 * Five-card draw: ante, five down cards, a betting round, one draw of up to
 * three cards (house rule — no 4-with-an-ace), a second betting round, then
 * showdown on the best five-card hand.
 *
 * Deck math: 6 players × 5 dealt + 6 × 3 worst-case draws = 48 ≤ 52, so the
 * deck always suffices and discards never need reshuffling.
 */

const MAX_DISCARDS = 3;

function drawLegal(): ExchangeLegal {
  return {
    kind: 'exchange',
    moves: [{ kind: 'discard', min: 0, max: MAX_DISCARDS }],
    autoMove: { kind: 'discard', cardIndexes: [] }, // timeout = stand pat
  };
}

/** Raw 0..1 strength of a made five-card hand (no draws coming after the swap). */
function drawStrength(hole: Card[]): number {
  const score = evaluate5(hole);
  const category = score >> 20;
  const base: Record<number, number> = {
    [CATEGORY.highCard]: 0.08,
    [CATEGORY.pair]: 0.32,
    [CATEGORY.twoPair]: 0.62,
    [CATEGORY.trips]: 0.78,
    [CATEGORY.straight]: 0.87,
    [CATEGORY.flush]: 0.91,
    [CATEGORY.fullHouse]: 0.95,
    [CATEGORY.quads]: 0.99,
    [CATEGORY.straightFlush]: 1,
  };
  const topKicker = (score >> 16) & 0xf;
  return Math.min(1, base[category] + topKicker / 120);
}

/** Which cards a sane player throws away. Exported for direct testing. */
export function chooseDiscards(hole: Card[]): number[] {
  const score = evaluate5(hole);
  const category = score >> 20;
  if (category >= CATEGORY.straight) return []; // made hand — stand pat

  // Group indexes by rank.
  const byRank = new Map<number, number[]>();
  hole.forEach((c, i) => {
    const v = rankValue(c);
    byRank.set(v, [...(byRank.get(v) ?? []), i]);
  });
  const groups = [...byRank.entries()].sort(
    (a, b) => b[1].length - a[1].length || b[0] - a[0]
  );

  if (groups[0][1].length >= 3) {
    // Trips (or better handled above): keep them, draw the rest.
    const keep = new Set(groups[0][1]);
    return hole.map((_, i) => i).filter((i) => !keep.has(i));
  }
  if (groups[0][1].length === 2 && groups[1]?.[1].length === 2) {
    // Two pair: draw one.
    const keep = new Set([...groups[0][1], ...groups[1][1]]);
    return hole.map((_, i) => i).filter((i) => !keep.has(i));
  }
  if (groups[0][1].length === 2) {
    // One pair: draw three.
    const keep = new Set(groups[0][1]);
    return hole.map((_, i) => i).filter((i) => !keep.has(i));
  }

  // Four to a flush: draw the odd suit.
  for (const suit of ['s', 'h', 'd', 'c']) {
    const inSuit = hole.map((c, i) => (suitOf(c) === suit ? i : -1)).filter((i) => i >= 0);
    if (inSuit.length === 4) {
      return hole.map((_, i) => i).filter((i) => !inSuit.includes(i));
    }
  }
  // Four to an open-ended straight: keep the run, draw the odd card.
  const sorted = hole
    .map((c, i) => ({ v: rankValue(c), i }))
    .sort((a, b) => a.v - b.v);
  const uniq = sorted.filter((x, k) => k === 0 || x.v !== sorted[k - 1].v);
  for (let s = 0; s + 3 < uniq.length; s++) {
    const run = uniq.slice(s, s + 4);
    if (run[3].v - run[0].v === 3) {
      const keep = new Set(run.map((x) => x.i));
      return hole.map((_, i) => i).filter((i) => !keep.has(i));
    }
  }

  // Nothing: keep the two highest cards, draw three.
  const keep = new Set(sorted.slice(-2).map((x) => x.i));
  return hole.map((_, i) => i).filter((i) => !keep.has(i));
}

export const fiveDraw: GameVariant = {
  id: 'five-draw',
  name: 'Five-Card Draw',
  marquee: 'FIVE-CARD DRAW',
  layoutHint: 'per-player',
  minPlayers: 2,
  fitsPlayers: (count) => count >= 2 && count <= 6,

  deal(v): PhasePlan {
    for (const id of v.hand.inHand) {
      const cards: Card[] = [];
      for (let i = 0; i < 5; i++) cards.push(v.draw());
      v.hand.playerCards[id] = { cards, faceUp: [false, false, false, false, false] };
    }
    return { kind: 'betting', street: 'first' };
  },

  nextPhase(v): PhasePlan {
    // The just-closed round names where we are; no extra state needed.
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
    return evaluate5(hand.playerCards[playerId].cards);
  },
  describeScore: describe,

  exchange: {
    // The draw's legal moves don't depend on who's asking — everyone may
    // swap 0–3; the engine has already checked whose turn it is.
    legal(): ExchangeLegal {
      return drawLegal();
    },
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ): { applied: { move: string; detail?: unknown } } | { error: MoveError } {
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

      // Public info, like a live table: how many cards each player took.
      v.emit('cards-drawn', { playerId, count: thrown.length });
      return { applied: { move: thrown.length === 0 ? 'stand pat' : 'draw', detail: { count: thrown.length } } };
    },
  },

  bot: {
    decideBet(view: BotView, randInt: RandInt) {
      return decideFromStrength(view, randInt, drawStrength(view.hole));
    },
    decideExchange(view: BotView): VariantMoveInput {
      return { kind: 'discard', cardIndexes: chooseDiscards(view.hole) };
    },
  },
};
