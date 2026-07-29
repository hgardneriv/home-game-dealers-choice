import type { Action, EngineCtx, EngineResult, GameState, LegalActions, PlayerMove } from './types';
import { applyAction, createGame } from './engine';
import { getLegalActions } from './betting';

/** Deterministic PRNG for tests (mulberry32). */
export function seededRandInt(seed: number): (maxExclusive: number) => number {
  let a = seed >>> 0;
  return (maxExclusive: number) => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    const r = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    return Math.floor(r * maxExclusive);
  };
}

export const NOW = 1_000_000;

/** Always-zero randInt: first-hand button lands on the lowest eligible seat. */
export const zeroRand = () => 0;

export function ok(res: EngineResult): GameState {
  if (!res.ok) throw new Error(`engine error ${res.error.code}: ${res.error.message}`);
  return res.state;
}

export function expectError(res: EngineResult, code: string): void {
  if (res.ok) throw new Error(`expected error ${code}, got success`);
  if (res.error.code !== code)
    throw new Error(`expected error ${code}, got ${res.error.code}: ${res.error.message}`);
}

/**
 * Test harness around a game: owns a mutable clock and RNG, applies actions,
 * and exposes common navigation helpers. Player ids are p0 (host) .. pN.
 */
export class Table {
  state: GameState;
  now = NOW;
  randInt: (n: number) => number;

  constructor(
    numPlayers: number,
    opts: {
      config?: Partial<GameState['config']>;
      stacks?: number[];
      seats?: number[];
      rand?: (n: number) => number;
    } = {}
  ) {
    this.randInt = opts.rand ?? zeroRand;
    this.state = createGame({
      id: 'game1',
      hostId: 'p0',
      hostName: 'P0',
      config: opts.config,
      now: this.now,
    });
    for (let i = 1; i < numPlayers; i++) {
      const seat = opts.seats?.[i] ?? i;
      this.apply({ type: 'requestSeat', playerId: `p${i}`, name: `P${i}`, seat });
      this.apply({ type: 'approveSeat', byId: 'p0', playerId: `p${i}` });
    }
    if (opts.stacks) {
      opts.stacks.forEach((stack, i) => {
        if (this.state.players[`p${i}`]) this.state.players[`p${i}`].stack = stack;
      });
    }
  }

  ctx(): EngineCtx {
    return { now: this.now, randInt: this.randInt };
  }

  apply(action: Action): GameState {
    this.state = ok(applyAction(this.state, action, this.ctx()));
    return this.state;
  }

  tryApply(action: Action): EngineResult {
    const res = applyAction(this.state, action, this.ctx());
    if (res.ok) this.state = res.state;
    return res;
  }

  start(): GameState {
    return this.apply({ type: 'startGame', byId: 'p0' });
  }

  act(playerId: string, move: PlayerMove, amount?: number): GameState {
    return this.apply({ type: 'playerAction', playerId, move, amount });
  }

  tryAct(playerId: string, move: PlayerMove, amount?: number): EngineResult {
    return this.tryApply({ type: 'playerAction', playerId, move, amount });
  }

  /** Advance the clock past nextHandAt and deal the next hand. */
  nextHand(): GameState {
    this.now = Math.max(this.now, this.state.nextHandAt ?? this.now) + 1;
    return this.apply({ type: 'nextHand' });
  }

  topUp(playerId: string): GameState {
    return this.apply({ type: 'topUp', playerId });
  }

  tryTopUp(playerId: string): EngineResult {
    return this.tryApply({ type: 'topUp', playerId });
  }

  get hand() {
    return this.state.hand!;
  }

  get toAct(): string | null {
    return this.state.hand?.round.toAct ?? null;
  }

  seatOf(playerId: string): number | null {
    return this.state.players[playerId].seat;
  }

  stack(playerId: string): number {
    return this.state.players[playerId].stack;
  }

  totalChips(): number {
    const stacks = Object.values(this.state.players).reduce((a, p) => a + p.stack, 0);
    const pot = this.state.hand
      ? Object.values(this.state.hand.totalCommitted).reduce((a, b) => a + b, 0)
      : 0;
    // Chips already paid out are back in stacks once a result exists.
    return this.state.hand?.result ? stacks : stacks + pot;
  }

  /**
   * Rig the current hand: overwrite hole cards and the upcoming board cards.
   * Cards must be chosen disjoint from each other; remaining deck cards that
   * happen to duplicate are never dealt (board is exactly 5 cards).
   */
  rig(holeCards: Record<string, [string, string]>, board: string[] = []): void {
    const hand = this.state.hand!;
    Object.assign(hand.holeCards, holeCards);
    board.forEach((card, i) => {
      hand.deck[hand.deckPos + i] = card;
    });
  }

  /** Fold every acting player until the hand ends. */
  foldAround(): void {
    let guard = 0;
    while ((this.state.phase as string) === 'playing') {
      if (guard++ > 30) throw new Error('foldAround did not terminate');
      this.act(this.toAct!, 'fold');
    }
  }

  /** Check/call until the board grows by `count` streets, then stop. */
  checkDownStreets(count: number): void {
    for (let i = 0; i < count; i++) {
      const startBoard = this.state.hand!.board.length;
      let guard = 0;
      while (this.state.phase === 'playing' && this.hand.board.length === startBoard) {
        if (guard++ > 30) throw new Error('street did not advance');
        const id = this.toAct!;
        const legal = legalFor(this.state, id);
        this.act(id, legal.canCheck ? 'check' : 'call');
      }
    }
  }

  /** Everyone checks/calls to showdown from the current point. */
  checkDown(): void {
    let guard = 0;
    while (this.state.phase === 'playing' && this.toAct !== null) {
      if (guard++ > 100) throw new Error('checkDown did not terminate');
      const id = this.toAct;
      const legal = legalFor(this.state, id);
      this.act(id, legal.canCheck ? 'check' : 'call');
    }
  }
}

export function legalFor(state: GameState, playerId: string): LegalActions {
  const legal = getLegalActions(state, playerId);
  if (!legal) throw new Error(`no legal actions for ${playerId} (not their turn)`);
  return legal;
}
