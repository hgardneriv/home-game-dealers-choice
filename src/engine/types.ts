// Core domain types for the poker engine. Pure data — no I/O, no framework.

/** Rank char + suit char, e.g. 'As', 'Td', '2c'. Ranks: 2-9,T,J,Q,K,A. Suits: s,h,d,c. */
export type Card = string;

export type Street = 'preflop' | 'flop' | 'turn' | 'river';

export type GamePhase = 'lobby' | 'playing' | 'hand-over' | 'paused' | 'ended';

export type PlayerStatus = 'seated' | 'away' | 'busted' | 'kicked' | 'left';

export interface TableConfig {
  startingStack: number; // $1 coins, default 20
  smallBlind: number; // default 1
  bigBlind: number; // default 2
  actionTimeMs: number; // default 20_000
  timeBankMs: number; // default 10_000
  maxSeats: number; // 6
}

export interface BotPersonality {
  /** 0..1 — higher folds more marginal hands */
  tightness: number;
  /** 0..1 — higher bets/raises more with strong hands */
  aggression: number;
  /** 0..1 — probability of bluffing in a bluffable spot */
  bluffFreq: number;
}

export interface Player {
  id: string;
  name: string;
  seat: number | null; // 0..5; null = not seated (spectator/removed)
  stack: number;
  status: PlayerStatus;
  timeBankMs: number;
  isHost: boolean;
  isBot: boolean;
  bot?: BotPersonality;
  /** Set once the player has been dealt into a hand — new joiners wait out the blind arc. */
  hasPlayed: boolean;
  lastSeenAt: number;
}

export interface SeatRequest {
  playerId: string;
  name: string;
  seat: number;
  at: number;
}

export interface BettingRound {
  street: Street;
  /** Highest total committed this street. */
  currentBet: number;
  /** Size of the last full bet/raise this street — the min-raise basis. Starts at BB preflop. */
  lastFullRaiseSize: number;
  /**
   * Bet level of the last FULL bet/raise. Short all-ins raise currentBet above
   * this; when currentBet - lastFullRaiseTo reaches lastFullRaiseSize the
   * cumulative short all-ins amount to a full raise and betting reopens.
   */
  lastFullRaiseTo: number;
  /** playerId -> chips committed this street. */
  committed: Record<string, number>;
  /** Players who have acted since the last FULL raise; reset on every full raise. */
  actedSinceFullRaise: string[];
  /** playerId of the last aggressor this street (bet or raise, incl. short all-in). */
  lastAggressor: string | null;
  toAct: string | null;
  /** Epoch ms when the acting player times out. Null when no one is to act. */
  actionDeadline: number | null;
  /** Deadline was already extended once with the player's time bank. */
  timeBankArmed: boolean;
  /** For bot turns: epoch ms after which the sweep resolves the bot's action. */
  botActAt: number | null;
}

export interface HandResult {
  pots: { amount: number; winners: string[]; eligible: string[] }[];
  /** Cards shown at showdown (losers auto-mucked unless they beat/tie all shown). */
  revealed: Record<string, [Card, Card]>;
  /** e.g. 'Two Pair, Aces and Eights' for each revealed hand. */
  descriptions: Record<string, string>;
  showdownOrder: string[];
  /** Uncalled excess returned before pots were built. */
  refunds: Record<string, number>;
}

export interface HandState {
  handNo: number;
  /** SECRET — never serialized to clients. */
  deck: Card[];
  deckPos: number;
  buttonSeat: number;
  /** Seat where the small blind is DUE (positional — may be an empty/busted seat). */
  sbSeat: number;
  /** True when no one posts the SB this hand (dead small blind). */
  deadSb: boolean;
  bbSeat: number;
  /** SECRET except each player's own entry. */
  holeCards: Record<string, [Card, Card]>;
  board: Card[];
  /** playerIds dealt in, in hand (clockwise) order starting left of button. */
  inHand: string[];
  folded: string[];
  allIn: string[];
  /** Whole-hand contributions per player — input to side-pot construction. */
  totalCommitted: Record<string, number>;
  round: BettingRound;
  result: HandResult | null;
}

export interface GameEvent {
  seq: number;
  at: number;
  type: string;
  data: unknown;
}

export interface GameState {
  id: string;
  /** Mirrors the Redis version counter after each CAS write. */
  version: number;
  phase: GamePhase;
  config: TableConfig;
  hostId: string;
  players: Record<string, Player>;
  /** length maxSeats; index = seat number; value = playerId or null. */
  seats: (string | null)[];
  seatRequests: SeatRequest[];
  hand: HandState | null;
  /** Seat that posted BB last hand — drives dead-button progression. */
  prevBbSeat: number | null;
  /** Epoch ms when the next hand auto-starts (between-hands pause). */
  nextHandAt: number | null;
  /** Host asked to pause; takes effect when the current hand ends. */
  pauseAfterHand: boolean;
  /** Why the game ended (set when phase becomes 'ended'). */
  endedReason: 'host' | 'lastPlayer' | null;
  /** Ring buffer of recent events, cap 100. */
  events: GameEvent[];
  eventSeq: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type PlayerMove = 'fold' | 'check' | 'call' | 'bet' | 'raise';

export type Action =
  | { type: 'requestSeat'; playerId: string; name: string; seat: number }
  | { type: 'approveSeat'; byId: string; playerId: string }
  | { type: 'denySeat'; byId: string; playerId: string }
  | { type: 'startGame'; byId: string }
  | { type: 'playerAction'; playerId: string; move: PlayerMove; amount?: number }
  | { type: 'timeout' } // server-generated; engine validates against actionDeadline
  | { type: 'nextHand' } // server-generated when nextHandAt has passed
  | { type: 'pause'; byId: string }
  | { type: 'resume'; byId: string }
  | { type: 'endGame'; byId: string }
  | { type: 'kick'; byId: string; playerId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'addBot'; byId: string }
  | { type: 'removeBot'; byId: string; playerId: string }
  | { type: 'imBack'; playerId: string };

export interface EngineCtx {
  now: number;
  /** Uniform int in [0, maxExclusive). Server injects crypto.randomInt. */
  randInt: (maxExclusive: number) => number;
}

export type EngineError = {
  code:
    | 'not-your-turn'
    | 'illegal-move'
    | 'bad-amount'
    | 'not-host'
    | 'seat-taken'
    | 'game-full'
    | 'bad-phase'
    | 'unknown-player'
    | 'not-expired'
    | 'noop';
  message: string;
};

export type EngineResult =
  | { ok: true; state: GameState; events: GameEvent[] }
  | { ok: false; error: EngineError };

export interface LegalActions {
  canFold: boolean;
  canCheck: boolean;
  /** Chips needed to call (already capped at stack); 0 when check is available. */
  callAmount: number;
  canBet: boolean; // opening bet available (currentBet === committed of everyone)
  canRaise: boolean;
  /** Minimum total-committed-this-street for a bet/raise (i.e. raise TO amount). */
  minRaiseTo: number;
  /** Maximum raise-to = player's stack + already committed (all-in). */
  maxRaiseTo: number;
}
