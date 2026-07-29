import type {
  Card,
  GameEvent,
  GamePhase,
  HandResult,
  LegalActions,
  Player,
  RoundKind,
  SeatRequest,
  TableConfig,
  VariantId,
} from '@/engine/types';
import type { GameState } from '@/engine/types';
import { getLegalActions } from '@/engine/betting';
import { getVariant } from '@/engine/variants/registry';

/**
 * The client-facing view of a game. A DISTINCT type from GameState so the
 * compiler stops us from ever serializing the raw state (deck, discards, and
 * everyone's face-down cards) to a response.
 */
export interface ClientGameState {
  id: string;
  version: number;
  phase: GamePhase;
  config: TableConfig;
  hostId: string;
  yourId: string | null;
  players: Record<string, ClientPlayer>;
  seats: (string | null)[];
  seatRequests: SeatRequest[];
  hand: ClientHand | null;
  /** Chips rolling into the next hand's pot (guts matches, in-between leftovers). */
  carryPot: number;
  /** Set while the dealer is picking the next game (M2+). */
  choosing: { buttonSeat: number; dealerId: string; deadline: number } | null;
  nextHandAt: number | null;
  pauseAfterHand: boolean;
  endedReason: 'host' | 'lastPlayer' | null;
  events: GameEvent[];
  now: number;
}

export interface ClientPlayer {
  id: string;
  name: string;
  seat: number | null;
  stack: number;
  status: Player['status'];
  timeBankMs: number;
  isHost: boolean;
  isBot: boolean;
  /** Public — the table can see who re-bought (it's in the events anyway). */
  totalBuyIn: number;
  topUpsUsed: number;
}

export interface ClientHand {
  handNo: number;
  variant: VariantId;
  buttonSeat: number;
  board: Card[];
  inHand: string[];
  folded: string[];
  allIn: string[];
  committed: Record<string, number>;
  totalCommitted: Record<string, number>;
  potTotal: number;
  street: string;
  roundKind: RoundKind;
  currentBet: number;
  toAct: string | null;
  actionDeadline: number | null;
  /** Your own cards, in dealt order. */
  myCards: Card[] | null;
  /** Everyone's face-up cards (stud up-cards, no-peek flips). Empty arrays omitted. */
  publicCards: Record<string, Card[]>;
  /** How many cards each dealt-in player holds — for rendering card backs. */
  cardCounts: Record<string, number>;
  /** Your legal actions when it is your turn, else null. */
  legalActions: LegalActions | null;
  result: HandResult | null;
}

export function redactForPlayer(state: GameState, playerId: string | null): ClientGameState {
  const players: Record<string, ClientPlayer> = {};
  for (const p of Object.values(state.players)) {
    players[p.id] = {
      id: p.id,
      name: p.name,
      seat: p.seat,
      stack: p.stack,
      status: p.status,
      timeBankMs: p.timeBankMs,
      isHost: p.isHost,
      isBot: p.isBot,
      totalBuyIn: p.totalBuyIn ?? state.config.startingStack,
      topUpsUsed: p.topUpsUsed ?? 0,
    };
  }

  let hand: ClientHand | null = null;
  if (state.hand) {
    const h = state.hand;
    const publicCards: Record<string, Card[]> = {};
    const cardCounts: Record<string, number> = {};
    for (const [id, pc] of Object.entries(h.playerCards)) {
      cardCounts[id] = pc.cards.length;
      const up = pc.cards.filter((_, i) => pc.faceUp[i]);
      if (up.length > 0) publicCards[id] = up;
    }
    hand = {
      handNo: h.handNo,
      variant: h.variant,
      buttonSeat: h.buttonSeat,
      board: [...h.board],
      inHand: [...h.inHand],
      folded: [...h.folded],
      allIn: [...h.allIn],
      committed: { ...h.round.committed },
      totalCommitted: { ...h.totalCommitted },
      potTotal: Object.values(h.totalCommitted).reduce((a, b) => a + b, 0) + h.pot,
      street: h.round.street,
      roundKind: h.round.kind,
      currentBet: h.round.currentBet,
      toAct: h.round.toAct,
      actionDeadline: h.round.actionDeadline,
      // No-peek games hide even your own face-down cards from you.
      myCards:
        playerId && h.playerCards[playerId]
          ? getVariant(h.variant).noPeek
            ? h.playerCards[playerId].cards.filter((_, i) => h.playerCards[playerId].faceUp[i])
            : [...h.playerCards[playerId].cards]
          : null,
      publicCards,
      cardCounts,
      legalActions:
        playerId && h.round.toAct === playerId ? getLegalActions(state, playerId) : null,
      result: h.result, // public at hand end (revealed cards only)
    };
  }

  return {
    id: state.id,
    version: state.version,
    phase: state.phase,
    config: state.config,
    hostId: state.hostId,
    yourId: playerId,
    players,
    seats: [...state.seats],
    seatRequests: [...state.seatRequests],
    hand,
    carryPot: state.carryPot ?? 0,
    choosing: state.choosing
      ? {
          buttonSeat: state.choosing.buttonSeat,
          dealerId: state.choosing.dealerId,
          deadline: state.choosing.deadline,
        }
      : null,
    nextHandAt: state.nextHandAt,
    pauseAfterHand: state.pauseAfterHand,
    endedReason: state.endedReason,
    events: state.events,
    now: Date.now(),
  };
}
