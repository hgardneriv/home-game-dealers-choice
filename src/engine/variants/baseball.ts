import type { Card, ExchangeLegal, GameState, HandState, VariantMoveInput } from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import { CATEGORY } from '../evaluator';
import { FIVE_OF_A_KIND, beatsVisible, evaluateWild, describeWild } from '../evaluator-wild';
import { decideFromStrength } from '../bot';
import type { RandInt } from '../deck';
import type { MoveError } from '../betting';

/**
 * Baseball: 7-card no-peek with 3s and 9s wild. Everyone gets 7 cards face
 * down that even the owner cannot see. Players take flip turns in hand order:
 * the first flipper turns exactly one card; every later flipper turns cards
 * one at a time until their visible hand STRICTLY beats the best visible hand
 * still live at the table — or runs out of cards and busts out of the hand.
 * Each completed flip turn is followed by a betting round opened by the best
 * visible hand. Showdown scores all seven cards with wilds.
 *
 * Deck math: 6 players × 7 = 42 ≤ 52.
 *
 * Phase choreography via vstate:
 *  - flipCursor: index into hand.inHand of whose flip turn is current/next.
 *  - betNo: counter naming the betting streets 'bet-1', 'bet-2', …
 * nextPhase alternates: a closed flip round yields a betting round; a closed
 * betting round advances the cursor to the next un-flipped player still in,
 * or showdown once everyone has had their turn.
 */

function cursorOf(hand: HandState): number {
  return (hand.vstate.flipCursor as number) ?? 0;
}

function activeIds(hand: HandState): string[] {
  return hand.inHand.filter((id) => !hand.folded.includes(id));
}

function visibleCards(hand: HandState, id: string): Card[] {
  const pc = hand.playerCards[id];
  return pc.cards.filter((_, i) => pc.faceUp[i]);
}

/** The best visible hand among the OTHER players still in — the hand to beat. */
function bestRivalVisible(hand: HandState, playerId: string): Card[] {
  let best: Card[] = [];
  let bestScore = -1;
  for (const id of activeIds(hand)) {
    if (id === playerId) continue;
    const cards = visibleCards(hand, id);
    const score = evaluateWild(cards);
    if (score > bestScore) {
      bestScore = score;
      best = cards;
    }
  }
  return best;
}

/**
 * A flip round belongs to one player. When their turn ends, mark every other
 * active player as settled so nextToAct returns null and the engine asks
 * nextPhase for the betting round.
 */
function closeFlipRound(hand: HandState, flipperId: string): void {
  const r = hand.round;
  for (const id of activeIds(hand)) {
    if (id !== flipperId && !r.actedSinceFullRaise.includes(id)) {
      r.actedSinceFullRaise.push(id);
    }
  }
}

const CATEGORY_STRENGTH: Record<number, number> = {
  [CATEGORY.highCard]: 0.1,
  [CATEGORY.pair]: 0.3,
  [CATEGORY.twoPair]: 0.45,
  [CATEGORY.trips]: 0.55,
  [CATEGORY.straight]: 0.65,
  [CATEGORY.flush]: 0.7,
  [CATEGORY.fullHouse]: 0.78,
  [CATEGORY.quads]: 0.85,
  [CATEGORY.straightFlush]: 0.93,
  [FIVE_OF_A_KIND]: 0.98,
};

/**
 * Bot betting strength from the VISIBLE cards only (no-peek: view.hole holds
 * flipped cards). Each hidden card is upside (it might be wild), discounted
 * when an opponent's board already has the visible hand beat.
 */
function visibleStrength(view: BotView): number {
  const myScore = evaluateWild(view.hole);
  const category = myScore >> 20;
  const topKicker = (myScore >> 16) & 0xf;
  const hidden = Math.max(0, 7 - view.hole.length);
  let strength = (CATEGORY_STRENGTH[category] ?? 0.1) + topKicker / 200 + hidden * 0.05;
  let bestRival = 0;
  for (const cards of Object.values(view.publicCards)) {
    bestRival = Math.max(bestRival, evaluateWild(cards));
  }
  if (bestRival > myScore) strength -= 0.3;
  return Math.max(0, Math.min(1, strength));
}

export const baseball: GameVariant = {
  id: 'baseball',
  name: 'Baseball (No-Peek)',
  marquee: 'BASEBALL · NO PEEK',
  layoutHint: 'per-player',
  minPlayers: 2,
  fitsPlayers: (count) => count >= 2 && count <= 6,
  noPeek: true,

  deal(v): PhasePlan {
    for (const id of v.hand.inHand) {
      const cards: Card[] = [];
      for (let i = 0; i < 7; i++) cards.push(v.draw());
      v.hand.playerCards[id] = { cards, faceUp: cards.map(() => false) };
    }
    v.hand.vstate.flipCursor = 0;
    v.hand.vstate.betNo = 0;
    return { kind: 'exchange', street: 'flip' };
  },

  nextPhase(v): PhasePlan {
    const hand = v.hand;
    if (hand.round.kind === 'exchange') {
      // A flip turn just closed — a betting round follows.
      const betNo = ((hand.vstate.betNo as number) ?? 0) + 1;
      hand.vstate.betNo = betNo;
      return { kind: 'betting', street: `bet-${betNo}` };
    }
    // A betting round closed — next player still in who hasn't had a flip
    // turn (skipping players folded or busted out), else showdown.
    let cur = cursorOf(hand) + 1;
    while (cur < hand.inHand.length && hand.folded.includes(hand.inHand[cur])) cur++;
    hand.vstate.flipCursor = cur;
    if (cur < hand.inHand.length) return { kind: 'exchange', street: 'flip' };
    return { kind: 'showdown' };
  },

  firstToAct(state: GameState, hand: HandState): string | null {
    if (hand.round.kind === 'exchange') {
      // The flip round belongs to the cursor player.
      for (let i = cursorOf(hand); i < hand.inHand.length; i++) {
        const id = hand.inHand[i];
        if (!hand.folded.includes(id)) return id;
      }
      return null;
    }
    // Betting: holder of the best visible hand who can act (all-in/folded
    // holders fall back to the next best); ties go clockwise from the button,
    // i.e. first in inHand order.
    let best: string | null = null;
    let bestScore = -1;
    for (const id of hand.inHand) {
      if (hand.folded.includes(id) || hand.allIn.includes(id)) continue;
      const score = evaluateWild(visibleCards(hand, id));
      if (score > bestScore) {
        best = id;
        bestScore = score;
      }
    }
    return best;
  },

  score(hand: HandState, playerId: string): number {
    return evaluateWild(hand.playerCards[playerId].cards);
  },
  describeScore: describeWild,

  exchange: {
    legal(): ExchangeLegal {
      return {
        kind: 'exchange',
        moves: [{ kind: 'flip' }],
        autoMove: { kind: 'flip' }, // timeout: the flip is forced anyway
      };
    },
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ):
      | { applied: { move: string; detail?: unknown }; turnContinues?: boolean }
      | { error: MoveError } {
      if (move.kind !== 'flip')
        return { error: { code: 'illegal-move', message: 'Expected a flip' } };
      const hand = v.hand;
      const pc = hand.playerCards[playerId];
      const next = pc.faceUp.indexOf(false);
      if (next === -1)
        return { error: { code: 'illegal-move', message: 'No cards left to flip' } };

      pc.faceUp[next] = true;
      const card = pc.cards[next];
      v.emit('flipped', { playerId, card });

      // The first flipper faces an empty board, so any card beats it — they
      // flip exactly one. Later flippers keep going until they take the lead.
      if (beatsVisible(visibleCards(hand, playerId), bestRivalVisible(hand, playerId))) {
        closeFlipRound(hand, playerId);
        return { applied: { move: 'flip', detail: { card, beat: true } } };
      }
      if (!pc.faceUp.includes(false)) {
        // All seven up without beating the board — out of the hand.
        hand.folded.push(playerId);
        v.emit('busted-out', { playerId });
        closeFlipRound(hand, playerId);
        return { applied: { move: 'flip', detail: { card, busted: true } } };
      }
      return { applied: { move: 'flip', detail: { card } }, turnContinues: true };
    },
  },

  bot: {
    decideBet(view: BotView, randInt: RandInt) {
      return decideFromStrength(view, randInt, visibleStrength(view));
    },
    decideExchange(): VariantMoveInput {
      return { kind: 'flip' }; // flipping is forced
    },
  },
};
