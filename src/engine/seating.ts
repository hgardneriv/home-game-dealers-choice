import type { GameState, Player } from './types';

/**
 * Seat/position helpers. Ante games need far less ceremony than blind games:
 * the button (dealer) advances one eligible seat per hand, everyone dealt in
 * antes, and action starts left of the button every phase. There is no dead
 * button, no blind arc — a new joiner is dealt into the very next hand.
 */

/** Player can be dealt a hand: seated (or away — they get anted/auto-folded) with chips. */
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

export interface HandSeating {
  buttonSeat: number;
  /** playerIds dealt in, clockwise starting left of the button. */
  inHand: string[];
}

/**
 * Compute the next hand's button and deal order. `prevButtonSeat` is the
 * previous hand's button (null for the first hand, which picks a random
 * button among the eligible seats). The button always lands on an eligible
 * player — busted/empty seats are skipped.
 */
export function computeButton(
  state: GameState,
  prevButtonSeat: number | null,
  randInt: (n: number) => number
): HandSeating | null {
  const eligible = eligiblePlayers(state);
  if (eligible.length < 2) return null;

  let buttonSeat: number;
  if (prevButtonSeat === null) {
    const seats = eligible.map((p) => p.seat!).sort((a, b) => a - b);
    buttonSeat = seats[randInt(seats.length)];
  } else {
    buttonSeat = nextEligibleSeat(state, prevButtonSeat);
  }

  return seatingAt(state, buttonSeat);
}

/**
 * Seating for a FIXED button seat (the choosing phase pins the button before
 * the hand exists; eligibility is re-read at deal time). Null when fewer than
 * two eligible players remain.
 */
export function seatingAt(state: GameState, buttonSeat: number): HandSeating | null {
  const eligible = eligiblePlayers(state);
  if (eligible.length < 2) return null;

  const n = state.config.maxSeats;
  const inHand: string[] = [];
  for (let i = 1; i <= n; i++) {
    const s = (buttonSeat + i) % n;
    const id = state.seats[s];
    if (id && eligible.some((p) => p.id === id)) inHand.push(id);
  }

  return { buttonSeat, inHand };
}
