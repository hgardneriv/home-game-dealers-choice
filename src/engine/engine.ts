import type {
  Action,
  EngineCtx,
  EngineResult,
  GameEvent,
  GameState,
  HandState,
  Player,
  TableConfig,
  VariantId,
} from './types';
import { newDeck, shuffle } from './deck';
import { computeButton, eligiblePlayers, isEligible, seatingAt } from './seating';
import { actors, active, applyMove, getLegalActions, nextToAct } from './betting';
import { resolveFoldWin, resolveShowdown } from './showdown';
import { topUpAmount } from './topup';
import { getVariant, isImplemented } from './variants/registry';
import type { GameVariant, PhasePlan, VariantCtx } from './variants/types';

export { getLegalActions };

const EVENT_CAP = 100;
/** Pause between hands so clients can show the result. */
const HAND_OVER_MS = { foldWin: 2500, showdown: 5000 };
/** How long a game-deciding bust holds the table open for a rebuy. */
const TOP_UP_WINDOW_MS = 20_000;
/** Bots "think" for a moment so play feels natural. */
const BOT_DELAY_BASE_MS = 800;
const BOT_DELAY_JITTER_MS = 1400;

export const DEFAULT_CONFIG: TableConfig = {
  startingStack: 20,
  ante: 1,
  minBet: 2,
  enabledVariants: ['holdem'],
  actionTimeMs: 20_000,
  timeBankMs: 10_000,
  maxSeats: 6,
  topUps: 2,
  topUpDecayPct: 50,
};

export function normalizeConfig(partial: Partial<TableConfig>): TableConfig {
  const cfg = { ...DEFAULT_CONFIG, ...partial, maxSeats: 6 };
  cfg.startingStack = clampInt(cfg.startingStack, 2, 10_000, DEFAULT_CONFIG.startingStack);
  cfg.ante = clampInt(cfg.ante, 1, cfg.startingStack, 1);
  // Min bet defaults to 2× ante and can never sit below the ante.
  cfg.minBet = clampInt(partial.minBet ?? cfg.ante * 2, cfg.ante, cfg.startingStack, cfg.ante * 2);
  cfg.actionTimeMs = clampInt(cfg.actionTimeMs, 5_000, 120_000, DEFAULT_CONFIG.actionTimeMs);
  cfg.timeBankMs = clampInt(cfg.timeBankMs, 0, 60_000, DEFAULT_CONFIG.timeBankMs);
  cfg.topUps = clampInt(cfg.topUps, 0, 20, DEFAULT_CONFIG.topUps);
  cfg.topUpDecayPct = clampInt(cfg.topUpDecayPct, 0, 100, DEFAULT_CONFIG.topUpDecayPct);
  // Only implemented variants may be enabled; never allow an empty list.
  const enabled = Array.isArray(cfg.enabledVariants)
    ? [...new Set(cfg.enabledVariants.filter((v) => typeof v === 'string' && isImplemented(v)))]
    : [];
  cfg.enabledVariants = enabled.length > 0 ? enabled : ['holdem'];
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
    lastSeenAt: opts.now,
    totalBuyIn: config.startingStack,
    topUpsUsed: 0,
    topUpAt: null,
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
    carryPot: 0,
    choosing: null,
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

/** The mutation surface handed to variant modules. */
function vctx(m: Mutable): VariantCtx {
  const state = m.state;
  const hand = state.hand!;
  return {
    state,
    hand,
    config: state.config,
    randInt: m.ctx.randInt,
    draw: () => hand.deck[hand.deckPos++],
    emit: (type, data = {}) => emit(m, type, data),
  };
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
        lastSeenAt: ctx.now,
        totalBuyIn: state.config.startingStack,
        topUpsUsed: 0,
        topUpAt: null,
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
      beginHand(m);
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

    case 'variantMove': {
      if (state.phase !== 'playing' || !state.hand)
        return fail('bad-phase', 'No hand in progress');
      const hand = state.hand;
      if (hand.round.toAct !== action.playerId)
        return fail('not-your-turn', 'Not your turn');
      if (hand.round.kind !== 'exchange')
        return fail('illegal-move', 'Not an exchange round');
      const player = state.players[action.playerId];
      if (player.status === 'away') {
        player.status = 'seated';
        emit(m, 'player-back', { playerId: player.id });
      }
      player.lastSeenAt = ctx.now;
      const variant = getVariant(hand.variant);
      const res = variant.exchange!.apply(vctx(m), action.playerId, action.move);
      if ('error' in res) return fail(res.error.code, res.error.message);
      emit(m, 'action', {
        playerId: action.playerId,
        move: res.applied.move,
        detail: res.applied.detail,
        street: hand.round.street,
        auto: false,
      });
      if (res.turnContinues) {
        // Multi-step turn (ace call → wager; repeated flips): same player,
        // fresh clock.
        hand.round.actionDeadline = null;
        hand.round.botActAt = null;
        advance(m);
        return done();
      }
      if (!hand.round.actedSinceFullRaise.includes(action.playerId))
        hand.round.actedSinceFullRaise.push(action.playerId);
      hand.round.toAct = nextToAct(hand, action.playerId);
      hand.round.actionDeadline = null;
      hand.round.botActAt = null;
      advance(m);
      return done();
    }

    case 'chooseGame': {
      if (state.phase !== 'choosing' || !state.choosing)
        return fail('bad-phase', 'No game selection pending');
      if (action.playerId !== state.choosing.dealerId)
        return fail('not-your-turn', "It's not your deal");
      if (!state.config.enabledVariants.includes(action.variant))
        return fail('illegal-move', 'That game is not enabled');
      const variant = getVariant(action.variant);
      const count = eligiblePlayers(state).length;
      if (count < variant.minPlayers || !variant.fitsPlayers(count))
        return fail('illegal-move', `${variant.name} does not fit this table`);
      const dealer = state.players[action.playerId];
      if (dealer.status === 'away') {
        dealer.status = 'seated';
        emit(m, 'player-back', { playerId: dealer.id });
      }
      dealer.lastSeenAt = ctx.now;
      emit(m, 'game-chosen', {
        dealerId: action.playerId,
        variant: action.variant,
        variantName: variant.name,
        auto: false,
      });
      startHand(m, action.variant);
      return done();
    }

    case 'chooseTimeout': {
      if (state.phase !== 'choosing' || !state.choosing)
        return fail('bad-phase', 'No game selection pending');
      if (ctx.now < state.choosing.deadline)
        return fail('not-expired', 'The dealer still has time');
      const dealer = state.players[state.choosing.dealerId];
      // An absent dealer keeps the current game going (repeat the last variant).
      const variantId = defaultVariant(state);
      if (dealer && !dealer.isBot && dealer.status === 'seated') {
        dealer.status = 'away';
        emit(m, 'player-away', { playerId: dealer.id });
      }
      emit(m, 'game-chosen', {
        dealerId: state.choosing.dealerId,
        variant: variantId,
        variantName: getVariant(variantId).name,
        auto: true,
      });
      startHand(m, variantId);
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
      if (legal.kind === 'exchange') {
        // Auto-play the variant's safe default (e.g. stand pat, forced flip).
        const variant = getVariant(hand.variant);
        const res = variant.exchange!.apply(vctx(m), acting, legal.autoMove);
        if (!('error' in res)) {
          emit(m, 'action', {
            playerId: acting,
            move: res.applied.move,
            detail: res.applied.detail,
            street: hand.round.street,
            auto: true,
          });
          if (res.turnContinues) {
            // Same player still owes a step; the away/instant deadline makes
            // the sweep drive the remaining forced moves one tick at a time.
            if (!player.isBot && player.status === 'seated') {
              player.status = 'away';
              emit(m, 'player-away', { playerId: acting });
            }
            hand.round.actionDeadline = null;
            hand.round.botActAt = null;
            advance(m);
            return done();
          }
        }
        if (!hand.round.actedSinceFullRaise.includes(acting))
          hand.round.actedSinceFullRaise.push(acting);
      } else {
        const move = legal.canCheck ? 'check' : 'fold';
        applyMove(state, acting, move, undefined);
        emit(m, 'action', {
          playerId: acting,
          move,
          amount: 0,
          street: hand.round.street,
          auto: true,
        });
      }
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
      beginHand(m);
      return done();
    }

    case 'pause': {
      const notHost = requireHost(action.byId);
      if (notHost) return notHost;
      if (state.phase === 'playing') {
        state.pauseAfterHand = true;
        emit(m, 'pause-requested', {});
      } else if (state.phase === 'hand-over' || state.phase === 'choosing') {
        // No live pot in either phase — pause immediately. Resume re-enters
        // the choosing flow via nextHand -> beginHand.
        state.phase = 'paused';
        state.nextHandAt = null;
        state.choosing = null;
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
      // reflect real money, then discard the unfinished hand. The communal
      // fund has no owners — endGame splits it evenly via carryPot.
      if (state.hand && !state.hand.result) {
        for (const [id, amount] of Object.entries(state.hand.totalCommitted)) {
          state.players[id].stack += amount;
        }
        state.carryPot += state.hand.pot;
        state.hand.pot = 0;
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
        lastSeenAt: ctx.now,
        totalBuyIn: state.config.startingStack,
        topUpsUsed: 0,
        topUpAt: null,
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

    case 'topUp': {
      const player = state.players[action.playerId];
      if (!player) return fail('unknown-player', 'No such player');
      if (state.phase === 'ended') return fail('bad-phase', 'Game is over');
      if (state.phase === 'lobby') return fail('bad-phase', 'Game has not started');
      if (player.status !== 'busted' || player.seat === null)
        return fail('illegal-move', 'You still have chips');
      const amount = topUpAmount(state.config, player.topUpsUsed ?? 0);
      if (amount <= 0) return fail('illegal-move', 'No top-ups remaining');

      player.stack = amount;
      player.totalBuyIn = (player.totalBuyIn ?? state.config.startingStack) + amount;
      player.topUpsUsed = (player.topUpsUsed ?? 0) + 1;
      player.status = 'seated';
      player.topUpAt = null;
      player.lastSeenAt = ctx.now;
      emit(m, 'topped-up', {
        playerId: player.id,
        amount,
        remaining: state.config.topUps - player.topUpsUsed,
      });

      // If this rebuy revived a game that was holding open for it, don't make
      // the table sit out the rest of the long window — deal soon.
      if (state.phase === 'hand-over' && state.nextHandAt !== null) {
        const chipped = Object.values(state.players).filter(
          (p) => p.seat !== null && p.stack > 0 && p.status !== 'kicked' && p.status !== 'left'
        );
        if (chipped.length >= 2) {
          state.nextHandAt = Math.min(state.nextHandAt, ctx.now + HAND_OVER_MS.showdown);
        }
      }
      return done();
    }
  }
}

// ---------------------------------------------------------------------------
// Hand lifecycle
// ---------------------------------------------------------------------------

/**
 * The variant a hand starts with when nobody is choosing: repeat the previous
 * hand's game while it stays enabled, else the first enabled variant. Also the
 * auto-pick an absent dealer gets once the choosing phase ships (M2).
 */
export function defaultVariant(state: GameState): VariantId {
  const prev = state.hand?.variant;
  if (prev && state.config.enabledVariants.includes(prev)) return prev;
  return state.config.enabledVariants[0];
}

/**
 * Between-hands entry point (startGame / nextHand / post-choosing recompute).
 * With one enabled variant, deal straight in — a classic single-game night has
 * zero picking latency. With more, park in 'choosing' until the dealer calls
 * the game (or the sweep does it for them).
 */
function beginHand(m: Mutable): void {
  const { state, ctx } = m;

  if (state.config.enabledVariants.length <= 1) {
    startHand(m, defaultVariant(state));
    return;
  }

  const chipped = Object.values(state.players).filter((p) => isEligible(p));
  if (chipped.length < 2) {
    endGame(m, chipped[0]?.id ?? null);
    return;
  }
  const seating = computeButton(state, state.hand?.buttonSeat ?? null, ctx.randInt);
  if (!seating) {
    endGame(m, null);
    return;
  }

  const dealerId = state.seats[seating.buttonSeat]!;
  const dealer = state.players[dealerId];
  state.phase = 'choosing';
  state.nextHandAt = null;
  state.choosing = {
    buttonSeat: seating.buttonSeat,
    dealerId,
    deadline: ctx.now + state.config.actionTimeMs,
    botChooseAt: dealer.isBot
      ? ctx.now + BOT_DELAY_BASE_MS + ctx.randInt(BOT_DELAY_JITTER_MS)
      : null,
  };
  emit(m, 'choosing-game', {
    dealerId,
    buttonSeat: seating.buttonSeat,
    options: [...state.config.enabledVariants],
  });
}

function startHand(m: Mutable, variantId: VariantId): void {
  const { state, ctx } = m;

  const chipped = Object.values(state.players).filter((p) => isEligible(p));
  if (chipped.length < 2) {
    endGame(m, chipped[0]?.id ?? null);
    return;
  }

  // The choosing phase pinned the button before the hand existed; otherwise
  // rotate from the previous hand's button.
  const seating = state.choosing
    ? seatingAt(state, state.choosing.buttonSeat)
    : computeButton(state, state.hand?.buttonSeat ?? null, ctx.randInt);
  if (!seating) {
    endGame(m, null);
    return;
  }

  const variant = getVariant(variantId);
  const deck = shuffle(newDeck(), ctx.randInt);
  const hand: HandState = {
    handNo: (state.hand?.handNo ?? 0) + 1,
    variant: variantId,
    deck,
    deckPos: 0,
    buttonSeat: seating.buttonSeat,
    playerCards: {},
    board: [],
    discards: [],
    inHand: seating.inHand,
    folded: [],
    allIn: [],
    totalCommitted: {},
    pot: 0,
    round: freshRound(state.config, 'betting', 'ante'),
    vstate: {},
    result: null,
  };

  state.hand = hand;
  state.phase = 'playing';
  state.nextHandAt = null;
  state.choosing = null;

  // Chips owed from earlier hands (guts matches, an unfinished in-between
  // pot) seed this hand's pot — whatever game the dealer called.
  hand.pot = state.carryPot;
  state.carryPot = 0;

  emit(m, 'hand-started', {
    handNo: hand.handNo,
    variant: variantId,
    variantName: variant.name,
    buttonSeat: hand.buttonSeat,
    inHand: hand.inHand,
    carried: hand.pot,
  });

  // Everyone dealt in antes (short stacks ante all-in — side pots handle it).
  // Communal-pot games (in-between) ante into the shared fund instead.
  const communal = variant.potStyle === 'communal';
  for (const id of hand.inHand) {
    const player = state.players[id];
    const chips = Math.min(state.config.ante, player.stack);
    player.stack -= chips;
    if (communal) hand.pot += chips;
    else hand.totalCommitted[id] = chips;
    if (player.stack === 0) hand.allIn.push(id);
  }
  emit(m, 'antes-posted', {
    amount: state.config.ante,
    playerIds: [...hand.inHand],
    potTotal:
      Object.values(hand.totalCommitted).reduce((a, b) => a + b, 0) + hand.pot,
  });

  const plan = variant.deal(vctx(m));
  if (plan.kind === 'showdown') {
    // Degenerate variant contract — settle immediately rather than wedge.
    finishHand(m, resolveHand(variant, hand), 'showdown');
    return;
  }
  openRound(m, plan);
  advance(m);
}

/** Standard showdown scoring, or the variant's custom resolution. */
function resolveHand(
  variant: GameVariant,
  hand: HandState
): ReturnType<typeof resolveShowdown> {
  if (variant.resolve) return variant.resolve(hand);
  return resolveShowdown(hand, variant.score, variant.describeScore);
}

/** Fresh turn-taking round of the given kind. */
function freshRound(
  config: TableConfig,
  kind: 'betting' | 'exchange',
  street: string
): HandState['round'] {
  return {
    street,
    kind,
    currentBet: 0,
    lastFullRaiseSize: config.minBet,
    lastFullRaiseTo: 0,
    committed: {},
    actedSinceFullRaise: [],
    // Reset per street: a street checked around => first-left-of-button shows
    // first at showdown. (All-in runouts skip openRound, so the last betting
    // street's aggressor correctly drives showdown order in that case.)
    lastAggressor: null,
    toAct: null,
    actionDeadline: null,
    timeBankArmed: false,
    botActAt: null,
  };
}

function openRound(m: Mutable, plan: { kind: 'betting' | 'exchange'; street: string }): void {
  const hand = m.state.hand!;
  hand.round = freshRound(m.state.config, plan.kind, plan.street);
  const variant = getVariant(hand.variant);
  // Players the variant declares decision-less this round (in-between: broke
  // players can only wager 0) start pre-settled — nextToAct walks past them,
  // and the variant's own turn-dealing honors actedSinceFullRaise.
  const sitsOut = variant.exchange?.sitsOut;
  if (plan.kind === 'exchange' && sitsOut) {
    for (const id of active(hand)) {
      if (sitsOut(m.state, id)) hand.round.actedSinceFullRaise.push(id);
    }
  }
  // Default opener is left of the button; a variant may override (stud's
  // "highest board showing acts first").
  hand.round.toAct = variant.firstToAct
    ? variant.firstToAct(m.state, hand)
    : nextToAct(hand, null);
}

/**
 * Drive the hand forward after any mutation: stamp the next turn, ask the
 * variant for the next phase when a round closes, skip betting phases nobody
 * can bet in (the all-in runout), and resolve fold-wins/showdowns.
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

  // Round complete: let the variant deal and name phases until one needs turns.
  const variant = getVariant(hand.variant);
  for (;;) {
    const plan: PhasePlan = variant.nextPhase(vctx(m));
    if (plan.kind === 'showdown') {
      finishHand(m, resolveHand(variant, hand), 'showdown');
      return;
    }
    openRound(m, plan);
    // All-in runout: a betting phase with <=1 player able to bet has no
    // decisions — deal straight through. (Exchange phases still run: an
    // all-in player draws cards like anyone else.)
    if (plan.kind === 'betting' && actors(hand).length <= 1) {
      hand.round.toAct = null;
      continue;
    }
    if (hand.round.toAct === null) continue;
    stampTurn(m);
    return;
  }
}

function stampTurn(m: Mutable): void {
  const { state, ctx } = m;
  const hand = state.hand!;
  const round = hand.round;
  const player = state.players[round.toAct!];
  round.timeBankArmed = false;
  if (player.isBot) {
    let wait = BOT_DELAY_BASE_MS + ctx.randInt(BOT_DELAY_JITTER_MS);
    // Result-reveal pause (in-between): hold the bot until the table has had
    // its look at the previous turn's card, then let it "think" as usual.
    const reveal = getVariant(hand.variant).resultReveal;
    if (reveal && round.kind === 'exchange') {
      let lastAt = -Infinity;
      for (const e of state.events) {
        if (e.type === reveal.eventType && (reveal.shows?.(e.data) ?? true)) lastAt = e.at;
      }
      wait = Math.max(wait, lastAt + reveal.ms - ctx.now + BOT_DELAY_BASE_MS);
    }
    round.botActAt = ctx.now + wait;
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

  const variant = getVariant(hand.variant);

  // The communal fund (carried chips + communal antes): main-pot winners take
  // it at showdown/fold-win; custom-resolve games (in-between) manage it
  // themselves and any leftover rolls to the next hand.
  if (hand.pot > 0) {
    const winners = variant.resolve ? [] : (resolution.result.pots[0]?.winners ?? []);
    if (winners.length > 0) {
      const base = Math.floor(hand.pot / winners.length);
      let remainder = hand.pot - base * winners.length;
      for (const id of winners) {
        const share = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        state.players[id].stack += share;
      }
      if (resolution.result.pots[0]) resolution.result.pots[0].amount += hand.pot;
    } else {
      state.carryPot += hand.pot;
      emit(m, 'pot-carried', { amount: hand.pot });
    }
    hand.pot = 0;
  }

  // Pot-matching settlement (guts): losers pay into the NEXT hand's pot,
  // capped at their stack — table stakes, chip conservation intact.
  const settled = variant.settle?.(vctx(m)) ?? null;
  if (settled) {
    let collected = 0;
    for (const [id, amount] of Object.entries(settled.payments)) {
      const player = state.players[id];
      const pay = Math.max(0, Math.min(Math.floor(amount), player.stack));
      if (pay === 0) continue;
      player.stack -= pay;
      collected += pay;
      emit(m, 'pot-matched', { playerId: id, amount: pay });
    }
    const carry = Math.max(0, Math.floor(settled.carry));
    if (collected + carry > 0) state.carryPot += collected + carry;
  }

  emit(m, 'hand-result', {
    handNo: hand.handNo,
    variant: hand.variant,
    kind,
    pots: resolution.result.pots,
    revealed: resolution.result.revealed,
    descriptions: resolution.result.descriptions,
    refunds: resolution.result.refunds,
    board: [...hand.board],
    carryPot: state.carryPot,
  });

  for (const player of Object.values(state.players)) {
    if (player.seat !== null && player.stack === 0 && player.status !== 'busted') {
      player.status = 'busted';
      emit(m, 'player-busted', { playerId: player.id });
      // Busted bots rebuy on their own after a "think" delay (sweep-driven).
      if (player.isBot && topUpAmount(state.config, player.topUpsUsed ?? 0) > 0) {
        player.topUpAt = ctx.now + BOT_DELAY_BASE_MS + ctx.randInt(BOT_DELAY_JITTER_MS);
      }
    }
  }

  // A bot table folds up the moment its last human busts with no rebuy left —
  // nobody wants to watch the bots finish the night without them.
  if (humansAreDone(state)) {
    const leader = chippedPlayers(state).sort((a, b) => b.stack - a.stack)[0];
    endGame(m, leader?.id ?? null, 'humansOut');
    return;
  }

  // 'holding' returns too: the extended rebuy deadline must not be overwritten
  // by the normal between-hands delay below (and the hold outranks a pending
  // pause — pauseAfterHand stays set for the next completed hand).
  if (settleOrHold(m) !== 'normal') return;

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

/** Seated, chipped, still-present players — the ones who could play a hand. */
function chippedPlayers(state: GameState): Player[] {
  return Object.values(state.players).filter(
    (p) => p.seat !== null && p.stack > 0 && p.status !== 'kicked' && p.status !== 'left'
  );
}

/**
 * True when bots are seated but no human can play another hand: every human
 * is busted (or gone) with no top-up left. A human who can still rebuy keeps
 * the table open — the normal hold-window/next-hand flow covers them.
 */
function humansAreDone(state: GameState): boolean {
  const botsSeated = Object.values(state.players).some((p) => p.isBot && p.seat !== null);
  if (!botsSeated) return false;
  return (
    !chippedPlayers(state).some((p) => !p.isBot) &&
    !eligibleRebuyers(state).some((p) => !p.isBot)
  );
}

/** Seated busted players whose next top-up is still available. */
function eligibleRebuyers(state: GameState): Player[] {
  return Object.values(state.players).filter(
    (p) =>
      p.seat !== null &&
      p.status === 'busted' &&
      topUpAmount(state.config, p.topUpsUsed ?? 0) > 0
  );
}

/**
 * End the game if it truly can't continue, or hold the table open when a
 * top-up could still save it. When a bust (or leave) drops the table below
 * two chipped players but rebuys remain, we park in 'hand-over' with an
 * extended deadline instead of ending; the expired window settles naturally
 * via nextHand -> startHand's "<2 eligible" endGame.
 */
function settleOrHold(m: Mutable): 'ended' | 'holding' | 'normal' {
  const { state, ctx } = m;
  const chipped = chippedPlayers(state);
  if (chipped.length >= 2) return 'normal';
  const rebuyers = eligibleRebuyers(state);
  if (chipped.length + rebuyers.length >= 2) {
    state.phase = 'hand-over';
    state.nextHandAt = Math.max(state.nextHandAt ?? 0, ctx.now + TOP_UP_WINDOW_MS);
    emit(m, 'top-up-window', {
      until: state.nextHandAt,
      playerIds: rebuyers.map((p) => p.id),
    });
    return 'holding';
  }
  endGame(m, chipped[0]?.id ?? null);
  return 'ended';
}

function endGame(
  m: Mutable,
  winnerId: string | null,
  reason: 'host' | 'lastPlayer' | 'humansOut' = 'lastPlayer'
): void {
  const { state } = m;
  // Chips owed to a next hand that will never come: split evenly among the
  // live seated players (remainder by seat order) so final standings add up.
  // Busted players only receive in the degenerate everyone-is-busted case —
  // and then the chips un-bust them, keeping "busted means zero" true.
  if (state.carryPot > 0) {
    const seated = state.seats.filter((id): id is string => id !== null);
    const live = seated.filter((id) => state.players[id].status !== 'busted');
    const recipients =
      live.length > 0 ? live : seated.length > 0 ? seated : Object.keys(state.players);
    if (recipients.length > 0) {
      const base = Math.floor(state.carryPot / recipients.length);
      let remainder = state.carryPot - base * recipients.length;
      for (const id of recipients) {
        const share = base + (remainder > 0 ? 1 : 0);
        if (remainder > 0) remainder--;
        const player = state.players[id];
        player.stack += share;
        if (player.status === 'busted' && player.stack > 0) player.status = 'seated';
      }
      state.carryPot = 0;
    }
  }
  state.phase = 'ended';
  state.nextHandAt = null;
  state.choosing = null;
  state.endedReason = reason;
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
  player.topUpAt = null;
  emit(m, 'player-removed', { playerId, status });

  if (state.phase === 'playing') advance(m);
  else if (state.phase === 'hand-over') {
    // Same gate as finishHand: the last chipped opponent leaving shouldn't end
    // the game while a busted player could still rebuy — and a rebuyer leaving
    // mid-window should settle it for the winner immediately.
    settleOrHold(m);
  } else if (state.phase === 'choosing') {
    // Recompute the pick: the leaver may have been the dealer, or the table
    // may no longer support a game. settleOrHold covers the can't-continue
    // cases; otherwise re-enter choosing (or deal straight in) fresh.
    state.choosing = null;
    if (settleOrHold(m) === 'normal') beginHand(m);
  }
}

export type { GameVariant };
