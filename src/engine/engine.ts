import type {
  Action,
  EngineCtx,
  EngineResult,
  GameEvent,
  GameState,
  HandState,
  Player,
  TableConfig,
} from './types';
import { newDeck, shuffle } from './deck';
import { computePositions, eligiblePlayers, isEligible } from './seating';
import {
  actors,
  active,
  applyMove,
  firstToAct,
  getLegalActions,
  nextToAct,
} from './betting';
import { resolveFoldWin, resolveShowdown } from './showdown';

export { getLegalActions };

const EVENT_CAP = 100;
/** Pause between hands so clients can show the result. */
const HAND_OVER_MS = { foldWin: 2500, showdown: 5000 };
/** Bots "think" for a moment so play feels natural. */
const BOT_DELAY_BASE_MS = 800;
const BOT_DELAY_JITTER_MS = 1400;

export const DEFAULT_CONFIG: TableConfig = {
  startingStack: 20,
  smallBlind: 1,
  bigBlind: 2,
  actionTimeMs: 20_000,
  timeBankMs: 10_000,
  maxSeats: 6,
};

export function normalizeConfig(partial: Partial<TableConfig>): TableConfig {
  const cfg = { ...DEFAULT_CONFIG, ...partial, maxSeats: 6 };
  cfg.startingStack = clampInt(cfg.startingStack, 2, 10_000, DEFAULT_CONFIG.startingStack);
  cfg.smallBlind = clampInt(cfg.smallBlind, 1, cfg.startingStack, 1);
  cfg.bigBlind = clampInt(cfg.bigBlind, cfg.smallBlind, cfg.startingStack, 2);
  cfg.actionTimeMs = clampInt(cfg.actionTimeMs, 5_000, 120_000, DEFAULT_CONFIG.actionTimeMs);
  cfg.timeBankMs = clampInt(cfg.timeBankMs, 0, 60_000, DEFAULT_CONFIG.timeBankMs);
  return cfg;
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function createGame(opts: {
  id: string;
  hostId: string;
  hostName: string;
  config?: Partial<TableConfig>;
  now: number;
}): GameState {
  const config = normalizeConfig(opts.config ?? {});
  const host: Player = {
    id: opts.hostId,
    name: opts.hostName,
    seat: 0,
    stack: config.startingStack,
    status: 'seated',
    timeBankMs: config.timeBankMs,
    isHost: true,
    isBot: false,
    hasPlayed: false,
    lastSeenAt: opts.now,
  };
  return {
    id: opts.id,
    version: 0,
    phase: 'lobby',
    config,
    hostId: opts.hostId,
    players: { [opts.hostId]: host },
    seats: [opts.hostId, null, null, null, null, null],
    seatRequests: [],
    hand: null,
    prevBbSeat: null,
    nextHandAt: null,
    pauseAfterHand: false,
    endedReason: null,
    events: [],
    eventSeq: 0,
    createdAt: opts.now,
    updatedAt: opts.now,
  };
}

const BOT_NAMES = ['Lucky Lou', 'Raisin Rita', 'Callin Carl', 'Foldin Fred', 'Bluffy', 'Chip Chaplin'];

// ---------------------------------------------------------------------------

type Mutable = { state: GameState; events: GameEvent[]; ctx: EngineCtx };

function emit(m: Mutable, type: string, data: unknown = {}): void {
  const event: GameEvent = { seq: ++m.state.eventSeq, at: m.ctx.now, type, data };
  m.state.events.push(event);
  if (m.state.events.length > EVENT_CAP) m.state.events.splice(0, m.state.events.length - EVENT_CAP);
  m.events.push(event);
}

/** Entry point: apply one action to an immutable state, returning the new state. */
export function applyAction(prev: GameState, action: Action, ctx: EngineCtx): EngineResult {
  const state = structuredClone(prev);
  const m: Mutable = { state, events: [], ctx };
  state.updatedAt = ctx.now;

  const fail = (code: string, message: string): EngineResult =>
    ({ ok: false, error: { code, message } }) as EngineResult;
  const done = (): EngineResult => ({ ok: true, state, events: m.events });

  const requireHost = (byId: string) =>
    byId === state.hostId ? null : fail('not-host', 'Only the host can do that');

  switch (action.type) {
    case 'requestSeat': {
      if (state.phase === 'ended') return fail('bad-phase', 'Game is over');
      if (state.players[action.playerId]) return fail('noop', 'Already in the game');
      const name = action.name.trim().slice(0, 20);
      if (!name) return fail('bad-amount', 'Name required');
      const hasRoom =
        state.seats.some((s) => s === null) ||
        Object.values(state.players).some((p) => p.isBot && p.seat !== null);
      if (!hasRoom) return fail('game-full', 'Table is full');
      state.players[action.playerId] = {
        id: action.playerId,
        name,
        seat: null,
        stack: state.config.startingStack,
        status: 'seated',
        timeBankMs: state.config.timeBankMs,
        isHost: false,
        isBot: false,
        hasPlayed: false,
        lastSeenAt: ctx.now,
      };
      state.seatRequests.push({
        playerId: action.playerId,
        name,
        seat: clampInt(action.seat, 0, 5, 0),
        at: ctx.now,
      });
      emit(m, 'seat-requested', { playerId: action.playerId, name });
      return done();
    }

    case 'approveSeat': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      const req = state.seatRequests.find((r) => r.playerId === action.playerId);
      if (!req) return fail('unknown-player', 'No such seat request');
      state.seatRequests = state.seatRequests.filter((r) => r.playerId !== action.playerId);

      let seat = state.seats[req.seat] === null ? req.seat : state.seats.indexOf(null);
      if (seat === -1) {
        // Full table: the newest bot yields its seat (folding mid-hand if needed).
        const bots = Object.values(state.players).filter((p) => p.isBot && p.seat !== null);
        const newest = bots[bots.length - 1];
        if (!newest) return fail('game-full', 'Table is full');
        removePlayer(m, newest.id, 'left');
        seat = state.seats.indexOf(null);
      }
      const player = state.players[action.playerId];
      player.seat = seat;
      state.seats[seat] = player.id;
      emit(m, 'player-seated', { playerId: player.id, name: player.name, seat });
      return done();
    }

    case 'denySeat': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (!state.seatRequests.some((r) => r.playerId === action.playerId))
        return fail('unknown-player', 'No such seat request');
      state.seatRequests = state.seatRequests.filter((r) => r.playerId !== action.playerId);
      delete state.players[action.playerId];
      emit(m, 'seat-denied', { playerId: action.playerId });
      return done();
    }

    case 'startGame': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase !== 'lobby') return fail('bad-phase', 'Game already started');
      if (eligiblePlayers(state).length < 2)
        return fail('bad-phase', 'Need at least 2 players');
      startHand(m);
      return done();
    }

    case 'playerAction': {
      if (state.phase !== 'playing' || !state.hand)
        return fail('bad-phase', 'No hand in progress');
      const hand = state.hand;
      if (hand.round.toAct !== action.playerId)
        return fail('not-your-turn', 'Not your turn');
      const player = state.players[action.playerId];
      if (player.status === 'away') {
        player.status = 'seated';
        emit(m, 'player-back', { playerId: player.id });
      }
      player.lastSeenAt = ctx.now;
      const res = applyMove(state, action.playerId, action.move, action.amount);
      if ('error' in res) return fail(res.error.code, res.error.message);
      emit(m, 'action', {
        playerId: action.playerId,
        move: res.applied.move,
        amount: res.applied.amount,
        street: hand.round.street,
        auto: false,
      });
      hand.round.toAct = nextToAct(hand, action.playerId);
      hand.round.actionDeadline = null;
      hand.round.botActAt = null;
      advance(m);
      return done();
    }

    case 'timeout': {
      if (state.phase !== 'playing' || !state.hand) return fail('bad-phase', 'No hand');
      const hand = state.hand;
      const acting = hand.round.toAct;
      if (!acting || hand.round.actionDeadline === null)
        return fail('not-expired', 'No one is on the clock');
      if (ctx.now < hand.round.actionDeadline)
        return fail('not-expired', 'Timer has not expired');
      const player = state.players[acting];

      if (!player.isBot && !hand.round.timeBankArmed && player.timeBankMs > 0) {
        hand.round.actionDeadline += player.timeBankMs;
        hand.round.timeBankArmed = true;
        emit(m, 'time-bank', { playerId: acting, extraMs: player.timeBankMs });
        player.timeBankMs = 0;
        return done();
      }

      const legal = getLegalActions(state, acting)!;
      const move = legal.canCheck ? 'check' : 'fold';
      applyMove(state, acting, move, undefined);
      emit(m, 'action', {
        playerId: acting,
        move,
        amount: 0,
        street: hand.round.street,
        auto: true,
      });
      if (!player.isBot && player.status === 'seated') {
        player.status = 'away';
        emit(m, 'player-away', { playerId: acting });
      }
      hand.round.toAct = nextToAct(hand, acting);
      hand.round.actionDeadline = null;
      hand.round.botActAt = null;
      advance(m);
      return done();
    }

    case 'nextHand': {
      if (state.phase !== 'hand-over') return fail('bad-phase', 'No hand pending');
      if (state.nextHandAt === null || ctx.now < state.nextHandAt)
        return fail('not-expired', 'Next hand not due yet');
      startHand(m);
      return done();
    }

    case 'pause': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase === 'playing') {
        state.pauseAfterHand = true;
        emit(m, 'pause-requested', {});
      } else if (state.phase === 'hand-over') {
        state.phase = 'paused';
        state.nextHandAt = null;
        emit(m, 'paused', {});
      } else {
        return fail('bad-phase', 'Nothing to pause');
      }
      return done();
    }

    case 'resume': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase !== 'paused') return fail('bad-phase', 'Not paused');
      state.pauseAfterHand = false;
      state.phase = 'hand-over';
      state.nextHandAt = ctx.now + 1500;
      emit(m, 'resumed', {});
      return done();
    }

    case 'endGame': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase === 'ended') return fail('bad-phase', 'Game is already over');
      // Return any chips still in the pot to their owners so final standings
      // reflect real money, then discard the unfinished hand.
      if (state.hand && !state.hand.result) {
        for (const [id, amount] of Object.entries(state.hand.totalCommitted)) {
          state.players[id].stack += amount;
        }
      }
      state.hand = null;
      endGame(m, null, 'host');
      return done();
    }

    case 'kick': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (action.playerId === state.hostId) return fail('illegal-move', 'Host cannot kick self');
      if (!state.players[action.playerId]) return fail('unknown-player', 'No such player');
      removePlayer(m, action.playerId, 'kicked');
      return done();
    }

    case 'leave': {
      if (!state.players[action.playerId]) return fail('unknown-player', 'No such player');
      removePlayer(m, action.playerId, 'left');
      return done();
    }

    case 'addBot': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase === 'ended') return fail('bad-phase', 'Game is over');
      const seat = state.seats.indexOf(null);
      if (seat === -1) return fail('game-full', 'No open seat');
      const used = new Set(Object.values(state.players).map((p) => p.name));
      const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Bot ${state.eventSeq}`;
      const id = `bot_${state.id}_${state.eventSeq}_${ctx.randInt(1_000_000)}`;
      state.players[id] = {
        id,
        name,
        seat,
        stack: state.config.startingStack,
        status: 'seated',
        timeBankMs: 0,
        isHost: false,
        isBot: true,
        bot: {
          tightness: 0.3 + ctx.randInt(40) / 100,
          aggression: 0.3 + ctx.randInt(50) / 100,
          bluffFreq: 0.05 + ctx.randInt(20) / 100,
        },
        hasPlayed: false,
        lastSeenAt: ctx.now,
      };
      state.seats[seat] = id;
      emit(m, 'player-seated', { playerId: id, name, seat, isBot: true });
      return done();
    }

    case 'removeBot': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      const bot = state.players[action.playerId];
      if (!bot?.isBot) return fail('unknown-player', 'No such bot');
      removePlayer(m, action.playerId, 'left');
      return done();
    }

    case 'imBack': {
      const player = state.players[action.playerId];
      if (!player) return fail('unknown-player', 'No such player');
      player.lastSeenAt = ctx.now;
      if (player.status === 'away') {
        player.status = 'seated';
        emit(m, 'player-back', { playerId: player.id });
        // If they returned on their own turn, give them a fresh clock instead
        // of the instant auto-fold an away player would get.
        const round = state.hand?.round;
        if (state.phase === 'playing' && round?.toAct === player.id) {
          round.actionDeadline = ctx.now + state.config.actionTimeMs;
          round.timeBankArmed = false;
        }
      }
      return done();
    }
  }
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

function startHand(m: Mutable): void {
  const { state, ctx } = m;
  const prev = state.hand
    ? { buttonSeat: state.hand.buttonSeat, sbSeat: state.hand.sbSeat, bbSeat: state.hand.bbSeat }
    : null;

  const chipped = Object.values(state.players).filter((p) => isEligible(p));
  if (chipped.length < 2) {
    endGame(m, chipped[0]?.id ?? null);
    return;
  }

  const positions = computePositions(state, prev, ctx.randInt);
  if (!positions) {
    endGame(m, null);
    return;
  }

  const deck = shuffle(newDeck(), ctx.randInt);
  const hand: HandState = {
    handNo: (state.hand?.handNo ?? 0) + 1,
    deck,
    deckPos: 0,
    buttonSeat: positions.buttonSeat,
    sbSeat: positions.sbSeat,
    deadSb: positions.deadSb,
    bbSeat: positions.bbSeat,
    holeCards: {},
    board: [],
    inHand: positions.inHand,
    folded: [],
    allIn: [],
    totalCommitted: {},
    round: {
      street: 'preflop',
      currentBet: state.config.bigBlind,
      lastFullRaiseSize: state.config.bigBlind,
      lastFullRaiseTo: state.config.bigBlind,
      committed: {},
      actedSinceFullRaise: [],
      lastAggressor: null,
      toAct: null,
      actionDeadline: null,
      timeBankArmed: false,
      botActAt: null,
    },
    result: null,
  };

  for (const id of positions.inHand) {
    hand.holeCards[id] = [hand.deck[hand.deckPos++], hand.deck[hand.deckPos++]];
    state.players[id].hasPlayed = true;
  }

  state.hand = hand;
  state.phase = 'playing';
  state.nextHandAt = null;
  state.prevBbSeat = positions.bbSeat;

  emit(m, 'hand-started', {
    handNo: hand.handNo,
    buttonSeat: hand.buttonSeat,
    sbSeat: hand.deadSb ? null : hand.sbSeat,
    bbSeat: hand.bbSeat,
    inHand: hand.inHand,
  });

  const post = (id: string, amount: number, kind: 'small' | 'big') => {
    const player = state.players[id];
    const chips = Math.min(amount, player.stack);
    player.stack -= chips;
    hand.round.committed[id] = chips;
    hand.totalCommitted[id] = chips;
    if (player.stack === 0) hand.allIn.push(id);
    emit(m, 'blind-posted', { playerId: id, amount: chips, kind });
  };
  if (!hand.deadSb) post(state.seats[hand.sbSeat]!, state.config.smallBlind, 'small');
  post(state.seats[hand.bbSeat]!, state.config.bigBlind, 'big');

  hand.round.toAct = firstToAct(state, hand);
  advance(m);
}

/**
 * Drive the hand forward after any mutation: stamp the next turn, advance
 * streets when the round closes, run out the board when betting is over,
 * and resolve fold-wins/showdowns.
 */
function advance(m: Mutable): void {
  const { state } = m;
  const hand = state.hand;
  if (!hand || state.phase !== 'playing') return;

  // Everyone else folded — instant win, no reveal.
  if (active(hand).length === 1) {
    finishHand(m, resolveFoldWin(hand), 'foldWin');
    return;
  }

  // Someone still owes a decision this round. Only stamp a fresh deadline if
  // the turn is new (null deadline) — advancing for unrelated reasons (e.g. a
  // bystander was kicked) must not reset the acting player's clock.
  if (hand.round.toAct !== null) {
    if (hand.round.actionDeadline === null) stampTurn(m);
    return;
  }

  // Round complete. Betting over entirely (<=1 player can still act)?
  if (actors(hand).length <= 1 && hand.board.length < 5) {
    // Run out the remaining streets with no betting.
    while (hand.board.length < 5) {
      dealStreet(m);
    }
    finishHand(m, resolveShowdown(hand), 'showdown');
    return;
  }

  if (hand.round.street === 'river') {
    finishHand(m, resolveShowdown(hand), 'showdown');
    return;
  }

  dealStreet(m);
  hand.round = {
    street: hand.board.length === 3 ? 'flop' : hand.board.length === 4 ? 'turn' : 'river',
    currentBet: 0,
    lastFullRaiseSize: state.config.bigBlind,
    lastFullRaiseTo: 0,
    committed: {},
    actedSinceFullRaise: [],
    // Reset per street: river checked around => first-left-of-button shows first.
    // (All-in runouts never reach here, so the last betting street's aggressor
    // correctly drives showdown order in that case.)
    lastAggressor: null,
    toAct: null,
    actionDeadline: null,
    timeBankArmed: false,
    botActAt: null,
  };
  hand.round.toAct = firstToAct(state, hand);
  advance(m); // recurse: stamps turn, or advances again if nobody can act
}

function dealStreet(m: Mutable): void {
  const hand = m.state.hand!;
  const count = hand.board.length === 0 ? 3 : 1;
  const cards = hand.deck.slice(hand.deckPos, hand.deckPos + count);
  hand.deckPos += count;
  hand.board.push(...cards);
  const street = hand.board.length === 3 ? 'flop' : hand.board.length === 4 ? 'turn' : 'river';
  emit(m, 'street-dealt', { street, cards, board: [...hand.board] });
}

function stampTurn(m: Mutable): void {
  const { state, ctx } = m;
  const hand = state.hand!;
  const round = hand.round;
  const player = state.players[round.toAct!];
  round.timeBankArmed = false;
  if (player.isBot) {
    round.botActAt = ctx.now + BOT_DELAY_BASE_MS + ctx.randInt(BOT_DELAY_JITTER_MS);
    round.actionDeadline = round.botActAt + 10_000; // fallback if bot logic ever fails
  } else if (player.status === 'away') {
    round.botActAt = null;
    round.actionDeadline = ctx.now; // sweep resolves instantly
    round.timeBankArmed = true;
  } else {
    round.botActAt = null;
    round.actionDeadline = ctx.now + state.config.actionTimeMs;
  }
  emit(m, 'turn', {
    playerId: round.toAct,
    street: round.street,
    deadline: round.actionDeadline,
  });
}

function finishHand(
  m: Mutable,
  resolution: ReturnType<typeof resolveShowdown>,
  kind: 'foldWin' | 'showdown'
): void {
  const { state, ctx } = m;
  const hand = state.hand!;
  hand.result = resolution.result;
  hand.round.toAct = null;
  hand.round.actionDeadline = null;
  hand.round.botActAt = null;

  for (const [id, amount] of Object.entries(resolution.payouts)) {
    state.players[id].stack += amount;
  }
  emit(m, 'hand-result', {
    handNo: hand.handNo,
    kind,
    pots: resolution.result.pots,
    revealed: resolution.result.revealed,
    descriptions: resolution.result.descriptions,
    refunds: resolution.result.refunds,
    board: [...hand.board],
  });

  for (const player of Object.values(state.players)) {
    if (player.seat !== null && player.stack === 0 && player.status !== 'busted') {
      player.status = 'busted';
      emit(m, 'player-busted', { playerId: player.id });
    }
  }

  const stillChipped = Object.values(state.players).filter(
    (p) => p.seat !== null && p.stack > 0 && p.status !== 'kicked' && p.status !== 'left'
  );
  if (stillChipped.length <= 1) {
    endGame(m, stillChipped[0]?.id ?? null);
    return;
  }

  if (state.pauseAfterHand) {
    state.pauseAfterHand = false;
    state.phase = 'paused';
    state.nextHandAt = null;
    emit(m, 'paused', {});
    return;
  }

  state.phase = 'hand-over';
  state.nextHandAt = ctx.now + HAND_OVER_MS[kind];
}

function endGame(
  m: Mutable,
  winnerId: string | null,
  reason: 'host' | 'lastPlayer' = 'lastPlayer'
): void {
  m.state.phase = 'ended';
  m.state.nextHandAt = null;
  m.state.endedReason = reason;
  emit(m, 'game-ended', { winnerId, reason });
}

/** Remove a player (kick/leave/bot-yield): fold them out of a live hand, free the seat. */
function removePlayer(m: Mutable, playerId: string, status: 'kicked' | 'left'): void {
  const { state } = m;
  const player = state.players[playerId];
  const hand = state.hand;

  state.seatRequests = state.seatRequests.filter((r) => r.playerId !== playerId);

  if (
    state.phase === 'playing' &&
    hand &&
    hand.inHand.includes(playerId) &&
    !hand.folded.includes(playerId)
  ) {
    hand.folded.push(playerId);
    emit(m, 'action', {
      playerId,
      move: 'fold',
      amount: 0,
      street: hand.round.street,
      auto: true,
    });
    if (hand.round.toAct === playerId) {
      hand.round.toAct = nextToAct(hand, playerId);
      hand.round.actionDeadline = null;
      hand.round.botActAt = null;
    }
  }

  if (player.seat !== null) {
    state.seats[player.seat] = null;
    player.seat = null;
  }
  player.status = status;
  emit(m, 'player-removed', { playerId, status });

  if (state.phase === 'playing') advance(m);
  else if (state.phase === 'hand-over' || state.phase === 'lobby') {
    const remaining = Object.values(state.players).filter(
      (p) => p.seat !== null && p.stack > 0
    );
    if (state.phase === 'hand-over' && remaining.length <= 1) {
      endGame(m, remaining[0]?.id ?? null);
    }
  }
}
