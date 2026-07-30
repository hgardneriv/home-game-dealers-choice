import type {
  Card,
  ExchangeLegal,
  GameState,
  HandState,
  VariantMoveInput,
} from '../types';
import type { BotView } from '../bot';
import type { GameVariant, PhasePlan, VariantCtx } from './types';
import type { MoveError } from '../betting';
import { newDeck, rankValue, shuffle, type RandInt } from '../deck';

/**
 * In-Between (acey-deucey). Not a showdown game: each player in turn bets
 * against the communal pot that a third card falls strictly between their two
 * face-up cards.
 *
 * A turn: two cards face-up on `hand.board`, then the player wagers
 * 0..min(pot, stack) (0 = pass). A pass burns NO card — the two up-cards
 * retire and the next card in the deck becomes the next player's first card
 * (house rule, play-testing 2026-07-29). On a wager the third card is dealt:
 * strictly between -> the player takes the wager from the pot; outside ->
 * pays the wager into the pot; equal in rank to either card ("hits the
 * post") -> pays DOUBLE the wager, capped at their stack (table stakes).
 * Retired cards go to `hand.discards`.
 *
 * Ace call: cards are dealt one at a time. If a turn's FIRST card is an ace,
 * the player declares it high or low before the second card is dealt (a
 * low-called ace counts as 1). A second-card or third-card ace is always
 * high (14).
 *
 * Play orbits (one turn per player per exchange round) until the pot is
 * empty. Backstop: an orbit in which everyone passes ends the hand — the
 * engine carries the leftover pot to the next hand (state.carryPot).
 *
 * Deck math: 3 cards per turn across unlimited orbits can exhaust 52 — when
 * fewer than 3 cards remain before a turn, the deck is rebuilt from a fresh
 * shuffle excluding any card currently on the board, and discards are
 * cleared (they are back in the deck).
 *
 * Event vocabulary (integration wires history/toasts):
 * - 'in-between-ace'      { playerId, card }
 *     A turn's first card is an ace; the player owes a high/low call.
 * - 'in-between-turn'     { playerId, cards: [Card, Card], aceLow?: boolean }
 *     A turn's two up-cards are set (after the ace call, if any).
 * - 'in-between-result'   { playerId, cards: [Card, Card], third: Card|null,
 *                           outcome: 'win'|'lose'|'post'|'pass',
 *                           amount, potAfter }
 *     The turn resolved. `third` is null on a pass (no card is burned);
 *     `amount` is the chips that actually moved (post = doubled wager capped
 *     at stack; pass = 0). Reveal machinery keys off `third` being non-null.
 * - 'in-between-reshuffle' {}
 *     The deck ran low and was rebuilt mid-hand.
 */

interface InBetweenState {
  /** A turn's first card is an ace; the player must call it high or low. */
  awaitingAce?: boolean;
  /** The current turn's first-card ace was called low (counts as 1). */
  aceLow?: boolean;
  /** Someone wagered > 0 this orbit — cleared when a new orbit opens. */
  anyWagered?: boolean;
}

function vs(hand: HandState): InBetweenState {
  return hand.vstate as InBetweenState;
}

/** First active player in hand order — who opens an orbit (matches nextToAct(hand, null)). */
function firstTurnPlayer(hand: HandState): string | null {
  return hand.inHand.find((id) => !hand.folded.includes(id)) ?? null;
}

/**
 * The player whose turn follows `fromId` this orbit: first id after them in
 * hand order that is still active and has not acted. The engine marks the
 * current player acted AFTER apply returns, so exclude them explicitly.
 */
function nextTurnPlayer(hand: HandState, fromId: string): string | null {
  const order = hand.inHand;
  const start = order.indexOf(fromId);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i) % order.length];
    if (id === fromId) continue;
    if (hand.folded.includes(id)) continue;
    if (hand.round.actedSinceFullRaise.includes(id)) continue;
    return id;
  }
  return null;
}

/**
 * Deal a turn's up-cards for `playerId`, rebuilding the deck first if fewer
 * than 3 cards remain (a full turn needs first + second + third). If the
 * first card is an ace, stop and await the high/low call — the second card
 * comes in apply().
 */
function dealTurn(v: VariantCtx, playerId: string): void {
  const hand = v.hand;
  if (hand.deck.length - hand.deckPos < 3) {
    const onBoard = new Set(hand.board);
    hand.deck = shuffle(
      newDeck().filter((c) => !onBoard.has(c)),
      v.randInt
    );
    hand.deckPos = 0;
    hand.discards = [];
    v.emit('in-between-reshuffle', {});
  }
  const st = vs(hand);
  st.aceLow = false;
  const first = v.draw();
  hand.board = [first];
  if (rankValue(first) === 14) {
    st.awaitingAce = true;
    v.emit('in-between-ace', { playerId, card: first });
    return;
  }
  st.awaitingAce = false;
  const second = v.draw();
  hand.board = [first, second];
  v.emit('in-between-turn', { playerId, cards: [first, second] });
}

export const inBetween: GameVariant = {
  id: 'in-between',
  name: 'In-Between',
  marquee: 'IN-BETWEEN',
  layoutHint: 'board',
  minPlayers: 2,
  fitsPlayers: (count) => count >= 2 && count <= 6,
  potStyle: 'communal',
  // Every turn's third card stays on display this long so the whole table
  // sees what was played before the next turn's cards replace it. A pass
  // burns no card, so it opens no reveal window.
  resultReveal: {
    eventType: 'in-between-result',
    ms: 4000,
    shows: (data) => (data as { third: Card | null }).third !== null,
  },

  deal(v): PhasePlan {
    const hand = v.hand;
    // Empty entries so per-player card counts render nothing.
    for (const id of hand.inHand) {
      hand.playerCards[id] = { cards: [], faceUp: [] };
    }
    vs(hand).anyWagered = false;
    const first = firstTurnPlayer(hand);
    if (!first) return { kind: 'showdown' };
    dealTurn(v, first);
    return { kind: 'exchange', street: 'in-between' };
  },

  nextPhase(v): PhasePlan {
    const hand = v.hand;
    const st = vs(hand);
    // Pot gone, or a full orbit of passes: the hand is over. resolve() below
    // returns an empty result; the engine carries any leftover pot.
    if (hand.pot === 0 || !st.anyWagered) return { kind: 'showdown' };
    st.anyWagered = false;
    const first = firstTurnPlayer(hand);
    if (!first) return { kind: 'showdown' };
    dealTurn(v, first);
    return { kind: 'exchange', street: 'in-between' };
  },

  // Never scored — chips move live during play; resolve() replaces showdown.
  score: () => 0,
  describeScore: () => '',

  resolve() {
    return {
      result: { pots: [], revealed: {}, descriptions: {}, showdownOrder: [], refunds: {} },
      payouts: {},
    };
  },

  exchange: {
    legal(state: GameState, playerId: string): ExchangeLegal {
      const hand = state.hand!;
      if (vs(hand).awaitingAce) {
        return {
          kind: 'exchange',
          moves: [{ kind: 'aceCall' }],
          autoMove: { kind: 'aceCall', high: false }, // timeout = low (worst case gone)
        };
      }
      const max = Math.min(hand.pot, state.players[playerId].stack);
      return {
        kind: 'exchange',
        moves: [{ kind: 'wager', min: 0, max }],
        autoMove: { kind: 'wager', amount: 0 }, // timeout = pass
      };
    },

    apply(
      v: VariantCtx,
      playerId: string,
      move: VariantMoveInput
    ): { applied: { move: string; detail?: unknown }; turnContinues?: boolean } | { error: MoveError } {
      const hand = v.hand;
      const st = vs(hand);

      if (move.kind === 'aceCall') {
        if (!st.awaitingAce)
          return { error: { code: 'illegal-move', message: 'No ace to call' } };
        st.awaitingAce = false;
        st.aceLow = !move.high;
        const second = v.draw();
        hand.board = [hand.board[0], second];
        v.emit('in-between-turn', {
          playerId,
          cards: [...hand.board],
          aceLow: st.aceLow,
        });
        // Same player still owes the wager — fresh clock.
        return { applied: { move: 'ace-call', detail: { high: move.high } }, turnContinues: true };
      }

      if (move.kind !== 'wager')
        return { error: { code: 'illegal-move', message: 'Expected a wager' } };
      if (st.awaitingAce)
        return { error: { code: 'illegal-move', message: 'Call the ace high or low first' } };
      if (hand.board.length !== 2)
        return { error: { code: 'illegal-move', message: 'No cards to bet on' } };

      const player = v.state.players[playerId];
      const max = Math.min(hand.pot, player.stack);
      const amount = move.amount;
      if (!Number.isInteger(amount) || amount < 0)
        return { error: { code: 'bad-amount', message: 'Wager must be a whole number of chips' } };
      if (amount > max)
        return { error: { code: 'bad-amount', message: `Wager at most ${max}` } };

      const [c1, c2] = hand.board;
      // A first-card ace called low counts as 1; a second-card ace is high.
      const v1 = st.aceLow ? 1 : rankValue(c1);
      const v2 = rankValue(c2);
      const lo = Math.min(v1, v2);
      const hi = Math.max(v1, v2);

      let outcome: 'win' | 'lose' | 'post' | 'pass';
      let moved = 0;
      let third: Card | null = null;
      if (amount === 0) {
        // Pass: no card is burned — the next card in the deck becomes the
        // next player's first up-card.
        outcome = 'pass';
      } else {
        third = v.draw();
        const t = rankValue(third);
        // "Hits the post" = matches either up-card's RANK (even a low-called ace).
        if (t === rankValue(c1) || t === rankValue(c2)) {
          outcome = 'post';
          moved = Math.min(amount * 2, player.stack); // double, table-stakes capped
          player.stack -= moved;
          hand.pot += moved;
        } else if (t > lo && t < hi) {
          outcome = 'win';
          moved = amount;
          player.stack += moved;
          hand.pot -= moved;
        } else {
          outcome = 'lose';
          moved = amount;
          player.stack -= moved;
          hand.pot += moved;
        }
        st.anyWagered = true;
      }
      if (player.stack === 0 && !hand.allIn.includes(playerId)) hand.allIn.push(playerId);

      // Retire the turn's cards.
      hand.discards.push(c1, c2);
      if (third !== null) hand.discards.push(third);
      hand.board = [];
      st.aceLow = false;

      v.emit('in-between-result', {
        playerId,
        cards: [c1, c2],
        third,
        outcome,
        amount: moved,
        potAfter: hand.pot,
      });

      if (hand.pot === 0) {
        // Pot is gone — settle everyone so the round closes and nextPhase
        // ends the hand instead of dealing more turns.
        for (const id of hand.inHand) {
          if (!hand.round.actedSinceFullRaise.includes(id))
            hand.round.actedSinceFullRaise.push(id);
        }
      } else {
        // Deal the next player's turn now (legal() is pure and cannot deal).
        const next = nextTurnPlayer(hand, playerId);
        if (next) dealTurn(v, next);
        // else: orbit closing — nextPhase deals the next orbit (or ends).
      }

      return {
        applied: {
          move: outcome === 'pass' ? 'pass' : 'wager',
          detail: { amount: moved, outcome, third },
        },
      };
    },
  },

  bot: {
    // No betting rounds in this game — never called.
    decideBet: () => ({ move: 'check' }),

    decideExchange(view: BotView, randInt: RandInt): VariantMoveInput {
      const spec = view.legal.kind === 'exchange' ? view.legal.moves[0] : null;
      if (spec?.kind === 'aceCall') return { kind: 'aceCall', high: randInt(2) === 1 };
      if (!spec || spec.kind !== 'wager' || spec.max <= 0 || view.board.length < 2)
        return { kind: 'wager', amount: 0 };
      // The view cannot see a recorded ace call — treat a first-card ace as
      // 14 (conservative: a low-called ace only widens the real window).
      const v1 = rankValue(view.board[0]);
      const v2 = rankValue(view.board[1]);
      const spread = Math.abs(v1 - v2) - 1;
      if (spread <= 4) return { kind: 'wager', amount: 0 };
      // The legal max is min(pot, stack) — the closest pot proxy the view
      // offers (view.potTotal only sums totalCommitted, empty for communal
      // games). Scale by spread and personality; deterministic given randInt.
      const potProxy = spec.max;
      const shaped =
        ((potProxy * (spread - 4)) / 16) * (0.5 + view.personality.aggression);
      const amount = Math.max(0, Math.min(spec.max, Math.round(shaped)));
      return { kind: 'wager', amount };
    },
  },
};
