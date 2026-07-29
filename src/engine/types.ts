// Core domain types for the poker engine. Pure data — no I/O, no framework.

/** Rank char + suit char, e.g. 'As', 'Td', '2c'. Ranks: 2-9,T,J,Q,K,A. Suits: s,h,d,c. */
export type Card = string;

/** Game variants a dealer can call. Only ids present in the registry are playable. */
export type VariantId =
  | 'holdem'
  | 'five-draw'
  | 'seven-stud'
  | 'guts'
  | 'baseball'
  | 'in-between';

export type GamePhase = 'lobby' | 'choosing' | 'playing' | 'hand-over' | 'paused' | 'ended';

export type PlayerStatus = 'seated' | 'away' | 'busted' | 'kicked' | 'left';

export interface TableConfig {
  startingStack: number; // $1 coins, default 20
  /** Posted by every dealt-in player at hand start. Default 1. */
  ante: number;
  /** Minimum opening bet (and the min-raise seed of a fresh street). Default 2 × ante. */
  minBet: number;
  /** Games the dealer may call. Always a non-empty subset of the implemented variants. */
  enabledVariants: VariantId[];
  actionTimeMs: number; // default 20_000
  timeBankMs: number; // default 10_000
  maxSeats: number; // 6
  /** Rebuys allowed per player after busting. 0 disables. Default 2. */
  topUps: number;
  /** Each successive top-up shrinks by this percent (0 = flat). Default 50. */
  topUpDecayPct: number;
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
  lastSeenAt: number;
  /** Cumulative buy-in: starting stack + every top-up taken. Drives net results and chip conservation. */
  totalBuyIn: number;
  /** Top-ups consumed so far. */
  topUpsUsed: number;
  /** Bots only: epoch ms after which the sweep auto-tops-up this busted bot. */
  topUpAt: number | null;
}

export interface SeatRequest {
  playerId: string;
  name: string;
  seat: number;
  at: number;
}

/**
 * A turn-taking phase is either a betting round or an exchange round (draw,
 * declare, flip, …) that reuses the same turn/clock machinery with betting
 * fields idle (currentBet stays 0).
 */
export type RoundKind = 'betting' | 'exchange';

export interface BettingRound {
  /** Variant-scoped phase label, e.g. 'preflop', 'flop', 'draw', 'third'. */
  street: string;
  kind: RoundKind;
  /** Highest total committed this street. */
  currentBet: number;
  /** Size of the last full bet/raise this street — the min-raise basis. Starts at minBet. */
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
  revealed: Record<string, Card[]>;
  /** e.g. 'Two Pair, Aces and Eights' for each revealed hand. */
  descriptions: Record<string, string>;
  showdownOrder: string[];
  /** Uncalled excess returned before pots were built. */
  refunds: Record<string, number>;
}

/** A player's dealt cards with per-card visibility (stud up-cards, no-peek flips). */
export interface PlayerCards {
  cards: Card[];
  /** Parallel to `cards`. true = public to the whole table. */
  faceUp: boolean[];
}

export interface HandState {
  handNo: number;
  /** Which game this hand is (the dealer's call). */
  variant: VariantId;
  /** SECRET — never serialized to clients. */
  deck: Card[];
  deckPos: number;
  /** The dealer. Rotates one eligible seat per hand. */
  buttonSeat: number;
  /** Face-down entries SECRET except each player's own. */
  playerCards: Record<string, PlayerCards>;
  /** Community cards; stays [] for non-board games. */
  board: Card[];
  /** SECRET — discarded cards (5-card draw). Never serialized to clients. */
  discards: Card[];
  /** playerIds dealt in, in hand (clockwise) order starting left of button. */
  inHand: string[];
  folded: string[];
  allIn: string[];
  /** Whole-hand contributions per player (incl. antes) — input to side-pot construction. */
  totalCommitted: Record<string, number>;
  round: BettingRound;
  /** Variant-private JSON-safe scratch (e.g. five-draw's drawDone flag). */
  vstate: Record<string, unknown>;
  result: HandResult | null;
}

export interface GameEvent {
  seq: number;
  at: number;
  type: string;
  data: unknown;
}

/** Between-hands state while the dealer picks the next game. */
export interface ChoosingState {
  /** Next hand's button seat, computed before the hand exists. */
  buttonSeat: number;
  /** Occupant of buttonSeat — the dealer making the call. */
  dealerId: string;
  /** Epoch ms; when passed, the sweep auto-picks (repeat last variant). */
  deadline: number;
  /** Bot dealers pick after a think delay (sweep-driven). */
  botChooseAt: number | null;
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
  /** Set while phase === 'choosing'; null otherwise. */
  choosing: ChoosingState | null;
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

/**
 * Variant-specific non-betting moves, one union member per mechanic. Grown as
 * variants ship; the engine routes them to the hand's variant module.
 */
export type VariantMoveInput = { kind: 'discard'; cardIndexes: number[] };

export type Action =
  | { type: 'requestSeat'; playerId: string; name: string; seat: number }
  | { type: 'approveSeat'; byId: string; playerId: string }
  | { type: 'denySeat'; byId: string; playerId: string }
  | { type: 'startGame'; byId: string }
  | { type: 'playerAction'; playerId: string; move: PlayerMove; amount?: number }
  | { type: 'variantMove'; playerId: string; move: VariantMoveInput }
  | { type: 'chooseGame'; playerId: string; variant: VariantId }
  | { type: 'chooseTimeout' } // server-generated; engine validates against choosing.deadline
  | { type: 'timeout' } // server-generated; engine validates against actionDeadline
  | { type: 'nextHand' } // server-generated when nextHandAt has passed
  | { type: 'pause'; byId: string }
  | { type: 'resume'; byId: string }
  | { type: 'endGame'; byId: string }
  | { type: 'kick'; byId: string; playerId: string }
  | { type: 'leave'; playerId: string }
  | { type: 'addBot'; byId: string }
  | { type: 'removeBot'; byId: string; playerId: string }
  | { type: 'imBack'; playerId: string }
  | { type: 'topUp'; playerId: string };

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

export interface BettingLegal {
  kind: 'betting';
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

/** What a variant move may look like right now, for rendering and validation. */
export type VariantMoveSpec = { kind: 'discard'; min: number; max: number };

export interface ExchangeLegal {
  kind: 'exchange';
  moves: VariantMoveSpec[];
  /** Applied by the engine on timeout / for away players (e.g. stand pat). */
  autoMove: VariantMoveInput;
}

export type LegalActions = BettingLegal | ExchangeLegal;
