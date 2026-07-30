import type {
  Card,
  ExchangeLegal,
  GameState,
  HandResult,
  HandState,
  TableConfig,
  VariantId,
  VariantMoveInput,
} from '../types';
import type { RandInt } from '../deck';
import type { BotDecision, BotView } from '../bot';
import type { MoveError } from '../betting';

/**
 * The contract every game module implements. Modules are pure — the state
 * stores only the VariantId (JSON-safe); the engine resolves the module via
 * the registry. All mutation happens through the VariantCtx the engine hands
 * in, on the engine's own working clone.
 */

export interface VariantCtx {
  state: GameState;
  hand: HandState;
  config: TableConfig;
  randInt: RandInt;
  /** Draw the next card off the deck (advances deckPos). */
  draw(): Card;
  /** Emit a game event (history + toasts). */
  emit(type: string, data?: unknown): void;
}

export type PhasePlan =
  | { kind: 'betting'; street: string }
  | { kind: 'exchange'; street: string }
  | { kind: 'showdown' };

export interface GameVariant {
  id: VariantId;
  /** 'Texas Hold'em' — checklist, header, events. */
  name: string;
  /** Felt marquee text, e.g. "TEXAS HOLD'EM". */
  marquee: string;
  /** Client hint: render community-board slots or per-player card rows. */
  layoutHint: 'board' | 'per-player';
  minPlayers: number;
  /** 52-card feasibility for this many dealt-in players. */
  fitsPlayers(count: number): boolean;

  /**
   * Where antes go. 'committed' (default): per-player totalCommitted, side
   * pots built normally. 'communal': straight into hand.pot — for games where
   * the pot changes hands mid-play (in-between).
   */
  potStyle?: 'committed' | 'communal';

  /**
   * No-peek games (baseball): players cannot see even their OWN face-down
   * cards — redaction and the bot view show only flipped cards until the
   * hand's result reveals the rest.
   */
  noPeek?: boolean;

  /**
   * Wild ranks (rank chars, e.g. ['3', '9'] for baseball). Purely
   * presentational — the client badges matching cards "WILD"; scoring
   * already lives in the variant's evaluator.
   */
  wildRanks?: string[];

  /**
   * Per-turn result reveal (in-between): after the variant emits `eventType`,
   * clients display the outcome for `ms` and the engine holds bots off their
   * next exchange turn until the window has passed, so every player sees the
   * card that was played.
   */
  resultReveal?: { eventType: string; ms: number };

  /**
   * Who opens a fresh round; default is left of the button (inHand[0]).
   * Stud overrides with "highest board showing".
   */
  firstToAct?(state: GameState, hand: HandState): string | null;

  /**
   * Full custom hand resolution replacing the standard showdown (in-between:
   * chips already moved during play; nothing to score). Leftover hand.pot
   * carries to the next hand automatically.
   */
  resolve?(hand: HandState): {
    result: HandResult;
    payouts: Record<string, number>;
  };

  /** Antes are already posted. Deal initial cards via v.draw; return the first phase. */
  deal(v: VariantCtx): PhasePlan;

  /**
   * The current phase closed (or is being skipped in an all-in runout). Deal
   * whatever the next phase needs; return it. MUST terminate: every call moves
   * a finite cursor toward 'showdown'.
   */
  nextPhase(v: VariantCtx): PhasePlan;

  /** Showdown scoring; bigger wins. Pure. */
  score(hand: HandState, playerId: string): number;
  describeScore(score: number): string;

  /** Exchange-phase behavior (absent for variants with betting phases only). */
  exchange?: {
    legal(state: GameState, playerId: string): ExchangeLegal;
    /**
     * Apply a move. `turnContinues: true` keeps the same player to act with a
     * fresh clock (multi-step turns: ace call then wager; repeated flips).
     */
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ):
      | { applied: { move: string; detail?: unknown }; turnContinues?: boolean }
      | { error: MoveError };
  };

  /**
   * Pot-matching settlement hook (guts, in-between): extra payments from
   * losers (each capped at that player's stack — table stakes) and chips
   * carried to the next pot. null = normal poker settlement.
   */
  settle?(v: VariantCtx): { payments: Record<string, number>; carry: number } | null;

  bot: {
    decideBet(view: BotView, randInt: RandInt): BotDecision;
    decideExchange?(view: BotView, randInt: RandInt): VariantMoveInput;
  };
}
