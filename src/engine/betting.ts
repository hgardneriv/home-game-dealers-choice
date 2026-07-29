import type {
  BettingLegal,
  GameState,
  HandState,
  LegalActions,
  PlayerMove,
} from './types';
import { getVariant } from './variants/registry';

/**
 * Betting-round mechanics. All functions here mutate the state they are given —
 * engine.ts clones the GameState once per action and these helpers work on the
 * clone.
 *
 * Bet/raise amounts are "raise TO" totals: the player's total commitment for
 * the current street after the action.
 *
 * Exchange rounds (draw/declare/…) reuse the same turn-walk machinery with the
 * betting fields idle: currentBet stays 0, so isSettled degenerates to "has
 * acted", which is exactly the semantics an exchange turn needs.
 */

/** Players still able to bet: dealt in, not folded, not all-in. */
export function actors(hand: HandState): string[] {
  return hand.inHand.filter((id) => !hand.folded.includes(id) && !hand.allIn.includes(id));
}

/** Players still contesting the pot (may be all-in). */
export function active(hand: HandState): string[] {
  return hand.inHand.filter((id) => !hand.folded.includes(id));
}

/**
 * Who takes turns this round: betting rounds walk the actors (all-in players
 * have no bet to make); exchange rounds walk everyone still in the pot —
 * an all-in player still draws cards.
 */
function turnTakers(hand: HandState): string[] {
  return hand.round.kind === 'exchange' ? active(hand) : actors(hand);
}

/** True when `id` has no pending decision this round. */
function isSettled(hand: HandState, id: string): boolean {
  const r = hand.round;
  return (
    (r.committed[id] ?? 0) === r.currentBet && r.actedSinceFullRaise.includes(id)
  );
}

/** Next player after `fromId` (cyclic hand order) who still owes a decision, or null. */
export function nextToAct(hand: HandState, fromId: string | null): string | null {
  const able = turnTakers(hand);
  if (able.length === 0) return null;
  const order = hand.inHand;
  const start = fromId ? order.indexOf(fromId) : -1;
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    if (able.includes(id) && !isSettled(hand, id)) return id;
  }
  return null;
}

/**
 * Legal actions for the player currently to act, or null. The single source
 * shared by the engine, server validation, the bot view, and (via redaction)
 * the client ActionBar — they can never disagree. Exchange rounds delegate to
 * the hand's variant module.
 */
export function getLegalActions(state: GameState, playerId: string): LegalActions | null {
  const hand = state.hand;
  if (!hand || hand.round.toAct !== playerId) return null;
  if (hand.round.kind === 'exchange') {
    return getVariant(hand.variant).exchange!.legal(state, playerId);
  }
  const r = hand.round;
  const player = state.players[playerId];
  const committed = r.committed[playerId] ?? 0;
  const toCall = r.currentBet - committed;
  const maxTo = committed + player.stack;
  const reopened = !r.actedSinceFullRaise.includes(playerId);

  const canBet = r.currentBet === 0 && player.stack > 0;
  const canRaise = r.currentBet > 0 && reopened && maxTo > r.currentBet;
  const minRaiseTo = canBet
    ? Math.min(state.config.minBet, maxTo)
    : Math.min(r.currentBet + r.lastFullRaiseSize, maxTo);

  return {
    kind: 'betting',
    canFold: true,
    canCheck: toCall <= 0,
    callAmount: toCall > 0 ? Math.min(toCall, player.stack) : 0,
    canBet,
    canRaise,
    minRaiseTo,
    maxRaiseTo: maxTo,
  };
}

export type MoveError = { code: 'illegal-move' | 'bad-amount'; message: string };

/**
 * Apply a validated betting move for the player currently to act. Mutates
 * state. Returns the normalized move actually applied (for events) or an
 * error. Does NOT advance toAct — the engine does that after checking round
 * status.
 */
export function applyMove(
  state: GameState,
  playerId: string,
  move: PlayerMove,
  amount: number | undefined
): { applied: { move: PlayerMove; amount: number } } | { error: MoveError } {
  const hand = state.hand!;
  const r = hand.round;
  const player = state.players[playerId];
  const legal = getLegalActions(state, playerId);
  if (!legal) return { error: { code: 'illegal-move', message: 'Not your turn' } };
  if (legal.kind !== 'betting')
    return { error: { code: 'illegal-move', message: 'Not a betting round' } };
  const committed = r.committed[playerId] ?? 0;

  const pay = (chips: number) => {
    player.stack -= chips;
    r.committed[playerId] = (r.committed[playerId] ?? 0) + chips;
    hand.totalCommitted[playerId] = (hand.totalCommitted[playerId] ?? 0) + chips;
    if (player.stack === 0 && !hand.allIn.includes(playerId)) hand.allIn.push(playerId);
  };
  const markActed = () => {
    if (!r.actedSinceFullRaise.includes(playerId)) r.actedSinceFullRaise.push(playerId);
  };

  switch (move) {
    case 'fold': {
      hand.folded.push(playerId);
      markActed();
      return { applied: { move, amount: 0 } };
    }
    case 'check': {
      if (!legal.canCheck)
        return { error: { code: 'illegal-move', message: 'Cannot check facing a bet' } };
      markActed();
      return { applied: { move, amount: 0 } };
    }
    case 'call': {
      if (legal.callAmount <= 0)
        return { error: { code: 'illegal-move', message: 'Nothing to call' } };
      pay(legal.callAmount);
      markActed();
      return { applied: { move, amount: legal.callAmount } };
    }
    case 'bet':
    case 'raise': {
      const isBet = r.currentBet === 0;
      if (isBet && !legal.canBet)
        return { error: { code: 'illegal-move', message: 'Cannot bet' } };
      if (!isBet && !legal.canRaise)
        return { error: { code: 'illegal-move', message: 'Betting is closed to you' } };
      const to = amount ?? 0;
      if (!Number.isInteger(to))
        return { error: { code: 'bad-amount', message: 'Amount must be a whole number' } };
      if (to > legal.maxRaiseTo)
        return { error: { code: 'bad-amount', message: 'Amount exceeds your stack' } };
      if (to <= r.currentBet)
        return { error: { code: 'bad-amount', message: 'Must exceed the current bet' } };
      const isAllIn = to === legal.maxRaiseTo;
      if (to < legal.minRaiseTo && !isAllIn)
        return {
          error: { code: 'bad-amount', message: `Minimum is ${legal.minRaiseTo}` },
        };

      pay(to - committed);
      const prevBet = r.currentBet;
      const fullRaise = isBet
        ? to >= state.config.minBet
        : to >= prevBet + r.lastFullRaiseSize;
      r.currentBet = to;
      r.lastAggressor = playerId;
      if (fullRaise) {
        r.lastFullRaiseSize = isBet ? to : to - prevBet;
        r.lastFullRaiseTo = to;
        r.actedSinceFullRaise = [playerId];
      } else if (to - r.lastFullRaiseTo >= r.lastFullRaiseSize) {
        // Cumulative short all-ins amount to a full raise: betting reopens,
        // but the min-raise basis stays the last full raise (TDA).
        r.lastFullRaiseTo = to;
        r.actedSinceFullRaise = [playerId];
      } else {
        markActed();
      }
      return { applied: { move: isBet ? 'bet' : 'raise', amount: to } };
    }
  }
}

export type { BettingLegal };
