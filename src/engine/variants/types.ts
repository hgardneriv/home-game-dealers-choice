import type {
  Card,
  ExchangeLegal,
  GameState,
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
    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ): { applied: { move: string; detail?: unknown } } | { error: MoveError };
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
