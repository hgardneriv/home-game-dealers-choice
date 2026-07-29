import type { GameState, Player } from './types';

/**
 * Seat/position helpers and the dead-button rule.
 *
 * Governing principle (Robert's Rules): the big blind advances exactly one
 * eligible seat per hand; the SB and button are placed positionally from the
 * previous hand even if that leaves them on an empty/busted seat (dead SB,
 * dead button). No one ever posts the BB twice in a row or gets the button
 * before passing through the blinds.
 */

/** Player can be dealt a hand: seated (or away — they get blinded/auto-folded) with chips. */
export function isEligible(p: Player | undefined): p is Player {
  return !!p && p.seat !== null && p.stack > 0 && (p.status === 'seated' || p.status === 'away');
}

export function eligiblePlayers(state: GameState): Player[] {
  return state.seats
    .map((id) => (id ? state.players[id] : undefined))
    .filter(isEligible);
}

/** Next seat index clockwise (ascending, wrapping). */
export function nextSeat(state: GameState, seat: number): number {
  return (seat + 1) % state.config.maxSeats;
}

/** First seat clockwise strictly after `seat` holding an eligible player, or -1. */
export function nextEligibleSeat(state: GameState, seat: number): number {
  const n = state.config.maxSeats;
  for (let i = 1; i <= n; i++) {
    const s = (seat + i) % n;
    const id = state.seats[s];
    if (id && isEligible(state.players[id])) return s;
  }
  return -1;
}

/** True if `seat` lies in the clockwise arc [from, to) — used for the blind-arc exclusion. */
export function inArc(seat: number, from: number, to: number, maxSeats: number): boolean {
  for (let s = from; s !== to; s = (s + 1) % maxSeats) {
    if (s === seat) return true;
  }
  return false;
}

export interface HandPositions {
  buttonSeat: number;
  sbSeat: number; // positional — where the SB is due
  deadSb: boolean;
  bbSeat: number;
  /** playerIds dealt in, clockwise starting left of the button. */
  inHand: string[];
}

/**
 * Compute positions for the next hand. `prev` is the previous hand's
 * positions (null for the first hand, which picks a random button).
 */
export function computePositions(
  state: GameState,
  prev: { buttonSeat: number; sbSeat: number; bbSeat: number } | null,
  randInt: (n: number) => number
): HandPositions | null {
  const eligible = eligiblePlayers(state);
  if (eligible.length < 2) return null;

  let buttonSeat: number;
  let sbSeat: number;
  let bbSeat: number;
  let deadSb: boolean;

  const headsUp = eligible.length === 2;

  if (!prev) {
    // First hand: random button among eligible seats.
    const seats = eligible.map((p) => p.seat!).sort((a, b) => a - b);
    buttonSeat = seats[randInt(seats.length)];
    if (headsUp) {
      sbSeat = buttonSeat; // heads-up: button posts the small blind
      bbSeat = nextEligibleSeat(state, buttonSeat);
    } else {
      sbSeat = nextEligibleSeat(state, buttonSeat);
      bbSeat = nextEligibleSeat(state, sbSeat);
    }
    deadSb = false;
  } else if (headsUp) {
    // Heads-up (including a 3+ -> 2 collapse): BB advances one eligible seat;
    // the other player takes button + SB. The previous BB never posts BB twice.
    bbSeat = nextEligibleSeat(state, prev.bbSeat);
    const other = eligible.find((p) => p.seat !== bbSeat)!;
    buttonSeat = other.seat!;
    sbSeat = buttonSeat;
    deadSb = false;
  } else {
    // Dead button rule: BB advances; SB is due where the BB just was; the
    // button lands where the SB was due — occupied or not.
    bbSeat = nextEligibleSeat(state, prev.bbSeat);
    sbSeat = prev.bbSeat;
    buttonSeat = prev.sbSeat;
    const sbId = state.seats[sbSeat];
    deadSb = !(sbId && isEligible(state.players[sbId]) && sbSeat !== bbSeat);
    // Degenerate wrap (e.g. many busts): if the button computed onto the BB seat,
    // pull it back to the nearest eligible seat before the SB position.
    if (buttonSeat === bbSeat) {
      buttonSeat = sbSeat;
      deadSb = true;
    }
  }

  // Blind-arc exclusion: a first-time player seated in [button, bb) would reach
  // the button before ever posting a blind — they sit out until the arc passes.
  const n = state.config.maxSeats;
  let dealt = eligible.filter(
    (p) => p.hasPlayed || !prev || !inArc(p.seat!, buttonSeat, bbSeat, n)
  );
  if (dealt.length < 2) dealt = eligible; // relax rather than stall the game

  // If the SB seat player got excluded, the SB is dead this hand.
  if (!deadSb && prev && !headsUp) {
    const sbId = state.seats[sbSeat];
    if (sbId && !dealt.some((p) => p.id === sbId)) deadSb = true;
  }

  // Hand order: clockwise from the seat after the button. This also covers
  // heads-up: order is [BB, button], preflop action starts after the BB (the
  // button) and postflop starts at inHand[0] (the BB) — both correct.
  const inHand: string[] = [];
  for (let i = 1; i <= n; i++) {
    const s = (buttonSeat + i) % n;
    const id = state.seats[s];
    if (id && dealt.some((p) => p.id === id)) inHand.push(id);
  }

  return { buttonSeat, sbSeat, deadSb, bbSeat, inHand };
}
