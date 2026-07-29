import type { Card, GameState, HandState } from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import { CATEGORY, describe, evaluate5, evaluate7 } from '../evaluator';
import { rankValue, suitOf, type RandInt } from '../deck';
import { decideFromStrength } from '../bot';

/**
 * Ante-based no-limit Seven-Card Stud (no bring-in — this table plays ante
 * poker): everyone antes, gets 2 down + 1 up, then bets on third street.
 * Fourth/fifth/sixth streets each deal one more UP card, seventh street one
 * more DOWN card, with a betting round after every deal. Best five of seven
 * at showdown. The best SHOWING board opens every betting round.
 *
 * Deck math: 6 players × 7 cards = 42 ≤ 52, so the deck always suffices.
 *
 * Event vocabulary: 'stud-street' { street, upCards: { playerId: card } } —
 * emitted once per dealt street (including third) with the newly-public
 * up-cards; seventh street (down) emits with an empty upCards record.
 */

/**
 * Pure strength of a SHOWING board (1–4 up-cards), higher = better. Made
 * groups first (quads > trips > two pair > pair > high cards), then ranks in
 * significance order. Same packing scheme as the evaluator (category << 20 |
 * 4-bit kickers) so scores compare directly. Suits never matter.
 */
export function boardStrength(upCards: Card[]): number {
  if (upCards.length === 0) return 0;
  const values = upCards.map(rankValue);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  // Count desc, then rank desc — the significance order for kickers.
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const category =
    groups[0][1] === 4
      ? CATEGORY.quads
      : groups[0][1] === 3
        ? CATEGORY.trips
        : groups[0][1] === 2 && groups[1]?.[1] === 2
          ? CATEGORY.twoPair
          : groups[0][1] === 2
            ? CATEGORY.pair
            : CATEGORY.highCard;
  let score = category << 20;
  groups.slice(0, 5).forEach(([rank], i) => {
    score |= rank << (16 - 4 * i);
  });
  return score;
}

/** Deal one card to every player still in (all-in players included). */
function dealStreet(v: VariantCtx, faceUp: boolean, street: string): void {
  const upCards: Record<string, Card> = {};
  for (const id of v.hand.inHand) {
    if (v.hand.folded.includes(id)) continue;
    const card = v.draw();
    const pc = v.hand.playerCards[id];
    pc.cards.push(card);
    pc.faceUp.push(faceUp);
    if (faceUp) upCards[id] = card;
  }
  v.emit('stud-street', { street, upCards });
}

export const sevenStud: GameVariant = {
  id: 'seven-stud',
  name: 'Seven-Card Stud',
  marquee: 'SEVEN-CARD STUD',
  layoutHint: 'per-player',
  minPlayers: 2,
  // 6 players × 7 cards = 42 of 52.
  fitsPlayers: (count) => count >= 2 && count <= 6,

  deal(v): PhasePlan {
    const upCards: Record<string, Card> = {};
    for (const id of v.hand.inHand) {
      const cards = [v.draw(), v.draw(), v.draw()];
      v.hand.playerCards[id] = { cards, faceUp: [false, false, true] };
      upCards[id] = cards[2];
    }
    v.emit('stud-street', { street: 'third', upCards });
    return { kind: 'betting', street: 'third' };
  },

  nextPhase(v): PhasePlan {
    // The just-closed round names where we are; no extra state needed.
    switch (v.hand.round.street) {
      case 'third':
        dealStreet(v, true, 'fourth');
        return { kind: 'betting', street: 'fourth' };
      case 'fourth':
        dealStreet(v, true, 'fifth');
        return { kind: 'betting', street: 'fifth' };
      case 'fifth':
        dealStreet(v, true, 'sixth');
        return { kind: 'betting', street: 'sixth' };
      case 'sixth':
        dealStreet(v, false, 'seventh');
        return { kind: 'betting', street: 'seventh' };
      default:
        return { kind: 'showdown' };
    }
  },

  /**
   * The best showing board opens every round. Ties break clockwise from the
   * button (first in hand order among the tied — sort stability keeps the
   * inHand order for equal boards). If the best board is all-in, the next-best
   * board that can still act opens; null when nobody can act.
   */
  firstToAct(state: GameState, hand: HandState): string | null {
    const boards = hand.inHand
      .filter((id) => !hand.folded.includes(id))
      .map((id) => {
        const pc = hand.playerCards[id];
        return { id, strength: boardStrength(pc.cards.filter((_, i) => pc.faceUp[i])) };
      });
    boards.sort((a, b) => b.strength - a.strength);
    return boards.find((b) => !hand.allIn.includes(b.id))?.id ?? null;
  },

  score(hand: HandState, playerId: string): number {
    return evaluate7(hand.playerCards[playerId].cards);
  },
  describeScore: describe,

  bot: {
    decideBet(view: BotView, randInt: RandInt) {
      return decideFromStrength(view, randInt, studViewStrength(view));
    },
  },
};

/** Same category → percentile map as five-draw's made-hand strengths. */
const MADE_BASE: Record<number, number> = {
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

/** Best five-card score from 5, 6, or 7 cards. */
function bestScore(cards: Card[]): number {
  if (cards.length === 7) return evaluate7(cards);
  if (cards.length === 6) {
    // Best of the 6 choose-5 combos: iterate the excluded card.
    let best = 0;
    for (let i = 0; i < 6; i++) {
      best = Math.max(best, evaluate5(cards.filter((_, k) => k !== i)));
    }
    return best;
  }
  return evaluate5(cards);
}

/** Raw 0..1 strength of the bot's own 3–7 stud cards. */
export function studStrength(cards: Card[]): number {
  if (cards.length >= 5) {
    const score = bestScore(cards);
    const category = score >> 20;
    const topKicker = (score >> 16) & 0xf;
    return Math.min(1, MADE_BASE[category] + topKicker / 120);
  }

  // 3–4 cards: made groups, then flush/straight potential and high cards.
  const values = cards.map(rankValue);
  const counts = new Map<number, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const desc = [...values].sort((a, b) => b - a);

  let strength: number;
  if (groups[0][1] >= 3) strength = 0.8 + groups[0][0] / 100;
  else if (groups[0][1] === 2 && groups[1]?.[1] === 2) strength = 0.6;
  else if (groups[0][1] === 2) strength = 0.3 + groups[0][0] / 50;
  else strength = 0.06 + desc[0] / 100 + (desc[1] ?? 0) / 200;

  // Three-flush / four-flush potential.
  const suits = new Map<string, number>();
  for (const c of cards) suits.set(suitOf(c), (suits.get(suitOf(c)) ?? 0) + 1);
  const maxSuit = Math.max(...suits.values());
  if (maxSuit >= 4) strength += 0.18;
  else if (maxSuit === 3) strength += 0.1;

  // Three ranks packed within a five-card window — straight potential.
  const uniq = [...new Set(values)].sort((a, b) => a - b);
  for (let i = 0; i + 2 < uniq.length; i++) {
    if (uniq[i + 2] - uniq[i] <= 4) {
      strength += 0.06;
      break;
    }
  }
  return Math.min(1, strength);
}

/** The bot's own made-hand category (grouped-ranks category for 3–4 cards). */
function ownCategory(cards: Card[]): number {
  if (cards.length >= 5) return bestScore(cards) >> 20;
  return boardStrength(cards) >> 20;
}

/**
 * studStrength with a small discount when an opponent's SHOWING board alone
 * already beats the bot's whole-hand category (e.g. villain shows trips and
 * we hold one pair).
 */
export function studViewStrength(view: Pick<BotView, 'hole' | 'publicCards'>): number {
  let strength = studStrength(view.hole);
  const mine = ownCategory(view.hole);
  for (const up of Object.values(view.publicCards)) {
    if (boardStrength(up) >> 20 > mine) {
      strength = Math.max(0, strength - 0.15);
      break;
    }
  }
  return strength;
}
