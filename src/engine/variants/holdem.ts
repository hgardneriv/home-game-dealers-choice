import type { HandState } from '../types';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import { describe, evaluate7 } from '../evaluator';
import { botDecide } from '../bot';

/**
 * Ante-based no-limit Texas Hold'em: 2 down cards each, then betting on
 * preflop/flop/turn/river with community cards. First to act is left of the
 * dealer on every street (no blinds anywhere in this app).
 */

const BOARD_TARGET = 5;

function dealBoard(v: VariantCtx, count: number, street: string): void {
  const cards: string[] = [];
  for (let i = 0; i < count; i++) cards.push(v.draw());
  v.hand.board.push(...cards);
  v.emit('street-dealt', { street, cards, board: [...v.hand.board] });
}

export const holdem: GameVariant = {
  id: 'holdem',
  name: "Texas Hold'em",
  marquee: "TEXAS HOLD'EM",
  layoutHint: 'board',
  minPlayers: 2,
  // 6 players × 2 + 5 board = 17 of 52.
  fitsPlayers: (count) => count >= 2 && count <= 6,

  deal(v): PhasePlan {
    for (const id of v.hand.inHand) {
      v.hand.playerCards[id] = { cards: [v.draw(), v.draw()], faceUp: [false, false] };
    }
    return { kind: 'betting', street: 'preflop' };
  },

  nextPhase(v): PhasePlan {
    const len = v.hand.board.length;
    if (len === 0) {
      dealBoard(v, 3, 'flop');
      return { kind: 'betting', street: 'flop' };
    }
    if (len < BOARD_TARGET) {
      const street = len === 3 ? 'turn' : 'river';
      dealBoard(v, 1, street);
      return { kind: 'betting', street };
    }
    return { kind: 'showdown' };
  },

  score(hand: HandState, playerId: string): number {
    return evaluate7([...hand.playerCards[playerId].cards, ...hand.board]);
  },
  describeScore: describe,

  bot: {
    decideBet: botDecide,
  },
};
