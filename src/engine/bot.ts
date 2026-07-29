import type { BotPersonality, Card, GameState, LegalActions, PlayerMove } from './types';
import { rankValue, suitOf, type RandInt } from './deck';
import { CATEGORY, evaluate5, evaluate7 } from './evaluator';
import { getLegalActions } from './betting';

/**
 * NPC decision-making. A bot decides from a narrow view built here — hole
 * cards, board, pot and legal actions only — so it structurally cannot use
 * the deck or opponents' cards.
 */

export interface BotView {
  hole: [Card, Card];
  board: Card[];
  potTotal: number;
  stack: number;
  committed: number;
  legal: LegalActions;
  activeCount: number;
  personality: BotPersonality;
  bigBlind: number;
}

export interface BotDecision {
  move: PlayerMove;
  amount?: number;
}

export function buildBotView(state: GameState, botId: string): BotView | null {
  const hand = state.hand;
  if (!hand) return null;
  const legal = getLegalActions(state, botId);
  if (!legal) return null;
  const player = state.players[botId];
  const potTotal = Object.values(hand.totalCommitted).reduce((a, b) => a + b, 0);
  return {
    hole: hand.holeCards[botId],
    board: [...hand.board],
    potTotal,
    stack: player.stack,
    committed: hand.round.committed[botId] ?? 0,
    legal,
    activeCount: hand.inHand.filter((id) => !hand.folded.includes(id)).length,
    personality: player.bot ?? { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1 },
    bigBlind: state.config.bigBlind,
  };
}

/** Chen-formula-ish preflop strength, normalized to 0..1. */
export function preflopStrength(hole: [Card, Card]): number {
  const [a, b] = hole;
  const va = rankValue(a);
  const vb = rankValue(b);
  const hi = Math.max(va, vb);
  const lo = Math.min(va, vb);

  let points =
    hi === 14 ? 10 : hi === 13 ? 8 : hi === 12 ? 7 : hi === 11 ? 6 : hi / 2;
  if (va === vb) points = Math.max(5, points * 2);
  if (suitOf(a) === suitOf(b)) points += 2;
  const gap = hi - lo - 1;
  if (va !== vb) {
    if (gap === 1) points -= 1;
    else if (gap === 2) points -= 2;
    else if (gap === 3) points -= 4;
    else if (gap >= 4) points -= 5;
    if (gap <= 1 && hi < 12) points += 1; // connector straight potential
  }
  return Math.max(0, Math.min(1, points / 20));
}

/** Made-hand strength on the current board, 0..1. */
export function postflopStrength(hole: [Card, Card], board: Card[]): number {
  const cards = [...hole, ...board];
  const score = cards.length === 7 ? evaluate7(cards) : evaluate5(cards.slice(0, 5));
  const category = score >> 20;
  // Rough percentile by category; top kicker nudges within category.
  const base: Record<number, number> = {
    [CATEGORY.highCard]: 0.12,
    [CATEGORY.pair]: 0.38,
    [CATEGORY.twoPair]: 0.62,
    [CATEGORY.trips]: 0.75,
    [CATEGORY.straight]: 0.85,
    [CATEGORY.flush]: 0.9,
    [CATEGORY.fullHouse]: 0.95,
    [CATEGORY.quads]: 0.99,
    [CATEGORY.straightFlush]: 1,
  };
  const topKicker = (score >> 16) & 0xf;
  let strength = Math.min(1, base[category] + topKicker / 140);
  // Strong draws are worth continuing with while cards are still to come.
  if (board.length >= 3 && board.length <= 4 && category < CATEGORY.straight) {
    if (hasFlushDraw(hole, board) || hasOpenEndedDraw(hole, board)) {
      strength = Math.max(strength, 0.5);
    }
  }
  return strength;
}

/** Four to a flush using at least one hole card. */
export function hasFlushDraw(hole: [Card, Card], board: Card[]): boolean {
  for (const suit of ['s', 'h', 'd', 'c']) {
    const total = [...hole, ...board].filter((c) => suitOf(c) === suit).length;
    const mine = hole.filter((c) => suitOf(c) === suit).length;
    if (total === 4 && mine >= 1) return true;
  }
  return false;
}

/** Four consecutive ranks (open-ended) using at least one hole card. */
export function hasOpenEndedDraw(hole: [Card, Card], board: Card[]): boolean {
  const holeValues = new Set(hole.map(rankValue));
  const values = [...new Set([...hole, ...board].map(rankValue))].sort((a, b) => a - b);
  for (let i = 0; i + 3 < values.length; i++) {
    const window = values.slice(i, i + 4);
    const isRun = window[3] - window[0] === 3;
    const usesHole = window.some((v) => holeValues.has(v));
    // Open-ended only if it can extend on both sides (not wheel/broadway edges).
    if (isRun && usesHole && window[0] > 2 && window[3] < 14) return true;
  }
  return false;
}

/** Decide a legal move from the view. Deterministic given randInt. */
export function botDecide(view: BotView, randInt: RandInt): BotDecision {
  const { legal, personality } = view;
  const noise = (randInt(21) - 10) / 100; // ±0.10
  const raw =
    view.board.length === 0
      ? preflopStrength(view.hole)
      : postflopStrength(view.hole, view.board);
  const strength = clamp01(raw + noise + (0.5 - personality.tightness) * 0.15);

  const wantsAggression = strength > 0.55 + (1 - personality.aggression) * 0.25;
  const bluffing =
    strength < 0.3 && randInt(100) < personality.bluffFreq * 60 && view.activeCount <= 3;

  const sizeBet = (): number => {
    // Between ~half pot and pot, shaped by aggression, clamped to legal range.
    const target = Math.round(
      Math.max(view.bigBlind, (view.potTotal || view.bigBlind * 2) * (0.5 + personality.aggression * 0.5))
    );
    return Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, view.committed + target));
  };

  if (legal.canCheck) {
    if ((wantsAggression || bluffing) && (legal.canBet || legal.canRaise)) {
      return { move: legal.canBet ? 'bet' : 'raise', amount: sizeBet() };
    }
    return { move: 'check' };
  }

  // Facing a bet. Continue when the hand justifies the price — with a floor
  // and a cap so bots defend against relentless betting instead of folding
  // everything short of two pair ("survival mode").
  const callAmount = legal.callAmount;
  const potOdds = callAmount / (view.potTotal + callAmount);
  const required = Math.min(
    0.72,
    0.18 + potOdds * 0.45 + personality.tightness * 0.1
  );

  if (legal.canRaise && (strength > 0.72 + (1 - personality.aggression) * 0.1 || (bluffing && randInt(100) < 30))) {
    return { move: 'raise', amount: sizeBet() };
  }
  if (strength >= required || callAmount === 0) {
    return { move: 'call' };
  }
  // Bluff catching: sometimes look them up anyway, so betting every hand
  // has a real cost. More likely for aggressive personalities.
  if (strength > 0.28 && randInt(100) < 12 + personality.aggression * 15) {
    return { move: 'call' };
  }
  // Cheap calls with live hands: never fold to a min bet with decent equity.
  if (strength > 0.3 && callAmount <= view.bigBlind) {
    return { move: 'call' };
  }
  return { move: 'fold' };
}

/** Convenience: full pipeline from game state to a decision. */
export function decideForBot(
  state: GameState,
  botId: string,
  randInt: RandInt
): BotDecision | null {
  const view = buildBotView(state, botId);
  if (!view) return null;
  const decision = botDecide(view, randInt);
  // Final legality clamp — a bot must never submit an illegal move.
  const legal = view.legal;
  if (decision.move === 'check' && !legal.canCheck) return { move: 'fold' };
  if (decision.move === 'call' && legal.callAmount === 0)
    return { move: legal.canCheck ? 'check' : 'fold' };
  if ((decision.move === 'bet' || decision.move === 'raise')) {
    if (!legal.canBet && !legal.canRaise)
      return { move: legal.callAmount > 0 ? 'call' : 'check' };
    const amount = Math.max(
      Math.min(decision.amount ?? legal.minRaiseTo, legal.maxRaiseTo),
      Math.min(legal.minRaiseTo, legal.maxRaiseTo)
    );
    return { move: legal.canBet ? 'bet' : 'raise', amount };
  }
  return decision;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
