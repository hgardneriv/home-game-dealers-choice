import type {
  Card,
  GameEvent,
  GamePhase,
  HandResult,
  LegalActions,
  Player,
  SeatRequest,
  Street,
  TableConfig,
} from '@/engine/types';
import type { GameState } from '@/engine/types';
import { getLegalActions } from '@/engine/betting';

/**
 * The client-facing view of a game. A DISTINCT type from GameState so the
 * compiler stops us from ever serializing the raw state (deck + everyone's
 * hole cards) to a response.
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
  buttonSeat: number;
  sbSeat: number;
  deadSb: boolean;
  bbSeat: number;
  board: Card[];
  inHand: string[];
  folded: string[];
  allIn: string[];
  committed: Record<string, number>;
  totalCommitted: Record<string, number>;
  potTotal: number;
  street: Street;
  currentBet: number;
  toAct: string | null;
  actionDeadline: number | null;
  /** Your hole cards only. */
  myCards: [Card, Card] | null;
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
      // Nullish defaults keep games persisted before the top-up feature valid.
      totalBuyIn: p.totalBuyIn ?? state.config.startingStack,
      topUpsUsed: p.topUpsUsed ?? 0,
    };
  }

  let hand: ClientHand | null = null;
  if (state.hand) {
    const h = state.hand;
    hand = {
      handNo: h.handNo,
      buttonSeat: h.buttonSeat,
      sbSeat: h.sbSeat,
      deadSb: h.deadSb,
      bbSeat: h.bbSeat,
      board: [...h.board],
      inHand: [...h.inHand],
      folded: [...h.folded],
      allIn: [...h.allIn],
      committed: { ...h.round.committed },
      totalCommitted: { ...h.totalCommitted },
      potTotal: Object.values(h.totalCommitted).reduce((a, b) => a + b, 0),
      street: h.round.street,
      currentBet: h.round.currentBet,
      toAct: h.round.toAct,
      actionDeadline: h.round.actionDeadline,
      myCards: playerId && h.holeCards[playerId] ? [...h.holeCards[playerId]] : null,
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
    nextHandAt: state.nextHandAt,
    pauseAfterHand: state.pauseAfterHand,
    endedReason: state.endedReason,
    events: state.events,
    now: Date.now(),
  };
}
