import type {
  BotPersonality,
  Card,
  GameState,
  LegalActions,
  PlayerMove,
  VariantId,
  VariantMoveInput,
} from './types';
import { rankValue, suitOf, type RandInt } from './deck';
import { CATEGORY, evaluate5, evaluate7 } from './evaluator';
import { getLegalActions } from './betting';
import { getVariant, isImplemented } from './variants/registry';
import { eligiblePlayers } from './seating';

/**
 * NPC decision-making. A bot decides from a narrow view built here — its own
 * cards, public cards, pot and legal actions only — so it structurally cannot
 * use the deck or opponents' hidden cards. The per-variant betting brain lives
 * on the variant module (`variant.bot`); this file holds the shared view
 * builder, the hold'em strength heuristics, and the final legality clamp.
 */

export interface BotView {
  /** The bot's own cards. */
  hole: Card[];
  board: Card[];
  /** Opponents' face-up cards (stud up-cards etc.); empty records otherwise. */
  publicCards: Record<string, Card[]>;
  potTotal: number;
  stack: number;
  committed: number;
  legal: LegalActions;
  activeCount: number;
  personality: BotPersonality;
  minBet: number;
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
  const publicCards: Record<string, Card[]> = {};
  for (const [id, pc] of Object.entries(hand.playerCards)) {
    if (id === botId) continue;
    const up = pc.cards.filter((_, i) => pc.faceUp[i]);
    if (up.length > 0) publicCards[id] = up;
  }
  return {
    hole: [...hand.playerCards[botId].cards],
    board: [...hand.board],
    publicCards,
    potTotal,
    stack: player.stack,
    committed: hand.round.committed[botId] ?? 0,
    legal,
    activeCount: hand.inHand.filter((id) => !hand.folded.includes(id)).length,
    personality: player.bot ?? { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1 },
    minBet: state.config.minBet,
  };
}

/** Chen-formula-ish preflop strength for two hole cards, normalized to 0..1. */
export function preflopStrength(hole: Card[]): number {
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
export function postflopStrength(hole: Card[], board: Card[]): number {
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
export function hasFlushDraw(hole: Card[], board: Card[]): boolean {
  for (const suit of ['s', 'h', 'd', 'c']) {
    const total = [...hole, ...board].filter((c) => suitOf(c) === suit).length;
    const mine = hole.filter((c) => suitOf(c) === suit).length;
    if (total === 4 && mine >= 1) return true;
  }
  return false;
}

/** Four consecutive ranks (open-ended) using at least one hole card. */
export function hasOpenEndedDraw(hole: Card[], board: Card[]): boolean {
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

/** Hold'em betting brain: decide a legal move from the view. Deterministic given randInt. */
export function botDecide(view: BotView, randInt: RandInt): BotDecision {
  const raw =
    view.board.length === 0
      ? preflopStrength(view.hole)
      : postflopStrength(view.hole, view.board);
  return decideFromStrength(view, randInt, raw);
}

/**
 * The shared betting-decision skeleton: variants supply a raw 0..1 hand
 * strength; personality, pot odds, bluffing, and sizing are common.
 */
export function decideFromStrength(view: BotView, randInt: RandInt, raw: number): BotDecision {
  const { personality } = view;
  if (view.legal.kind !== 'betting') return { move: 'check' };
  const legal = view.legal;
  const noise = (randInt(21) - 10) / 100; // ±0.10
  const strength = clamp01(raw + noise + (0.5 - personality.tightness) * 0.15);

  const wantsAggression = strength > 0.55 + (1 - personality.aggression) * 0.25;
  const bluffing =
    strength < 0.3 && randInt(100) < personality.bluffFreq * 60 && view.activeCount <= 3;

  const sizeBet = (): number => {
    // Between ~half pot and pot, shaped by aggression, clamped to legal range.
    const target = Math.round(
      Math.max(view.minBet, (view.potTotal || view.minBet * 2) * (0.5 + personality.aggression * 0.5))
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
  if (strength > 0.3 && callAmount <= view.minBet) {
    return { move: 'call' };
  }
  return { move: 'fold' };
}

/** Full pipeline from game state to an exchange move (exchange rounds only). */
export function decideExchangeForBot(
  state: GameState,
  botId: string,
  randInt: RandInt
): VariantMoveInput | null {
  const hand = state.hand;
  if (!hand || hand.round.kind !== 'exchange') return null;
  const view = buildBotView(state, botId);
  if (!view || view.legal.kind !== 'exchange') return null;
  const variant = getVariant(hand.variant);
  const move = variant.bot.decideExchange?.(view, randInt);
  // Safe default: the variant's auto move (e.g. stand pat).
  return move ?? view.legal.autoMove;
}

/** Convenience: full pipeline from game state to a betting decision (betting rounds only). */
export function decideForBot(
  state: GameState,
  botId: string,
  randInt: RandInt
): BotDecision | null {
  const hand = state.hand;
  if (!hand || hand.round.kind !== 'betting') return null;
  const view = buildBotView(state, botId);
  if (!view || view.legal.kind !== 'betting') return null;
  const decision = getVariant(hand.variant).bot.decideBet(view, randInt);
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

/**
 * A bot dealer's pick: uniform over the enabled games that fit the current
 * table. Personalities could weight this later.
 */
export function botChooseVariant(state: GameState, randInt: RandInt): VariantId {
  const count = eligiblePlayers(state).length;
  const options = state.config.enabledVariants.filter((id) => {
    if (!isImplemented(id)) return false;
    const v = getVariant(id);
    return count >= v.minPlayers && v.fitsPlayers(count);
  });
  if (options.length === 0) return state.config.enabledVariants[0];
  return options[randInt(options.length)];
}
