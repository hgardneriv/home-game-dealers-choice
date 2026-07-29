import { describe, expect, it } from 'vitest';
import type { GameState, Player, PlayerStatus, TableConfig } from './types';
import { computeButton, isEligible, nextEligibleSeat, nextSeat } from './seating';

/**
 * Mutation-hardening tests for seating.ts. Each test pins a rule a surviving
 * Stryker mutant would break. Pure functions are exercised directly with
 * hand-built state fragments — computeButton only reads config.maxSeats,
 * seats and players.
 */

const zeroRand = () => 0;

interface SeatSpec {
  id: string;
  seat: number;
  stack?: number;
  status?: PlayerStatus;
}

function makePlayer(spec: {
  id: string;
  seat?: number | null;
  stack?: number;
  status?: PlayerStatus;
}): Player {
  return {
    id: spec.id,
    name: spec.id,
    seat: spec.seat ?? null,
    stack: spec.stack ?? 20,
    status: spec.status ?? 'seated',
    timeBankMs: 0,
    isHost: false,
    isBot: false,
    lastSeenAt: 0,
    totalBuyIn: 20,
    topUpsUsed: 0,
    topUpAt: null,
  };
}

function makeState(specs: SeatSpec[], maxSeats = 6): GameState {
  const seats: (string | null)[] = Array(maxSeats).fill(null);
  const players: Record<string, Player> = {};
  for (const s of specs) {
    seats[s.seat] = s.id;
    players[s.id] = makePlayer(s);
  }
  return { config: { maxSeats } as TableConfig, seats, players } as unknown as GameState;
}

describe('isEligible', () => {
  // Kills ConditionalExpression true/false, EqualityOperator variants,
  // StringLiteral '' on either status literal.
  it('accepts seated and away players holding chips', () => {
    expect(isEligible(makePlayer({ id: 'a', seat: 0 }))).toBe(true);
    expect(isEligible(makePlayer({ id: 'a', seat: 0, status: 'away' }))).toBe(true);
  });

  it('rejects missing, unseated, broke, and busted players', () => {
    expect(isEligible(undefined)).toBe(false);
    expect(isEligible(makePlayer({ id: 'a', seat: null }))).toBe(false);
    expect(isEligible(makePlayer({ id: 'a', seat: 0, stack: 0 }))).toBe(false);
    expect(isEligible(makePlayer({ id: 'a', seat: 0, stack: 5, status: 'busted' }))).toBe(false);
  });
});

describe('nextSeat', () => {
  // Kills BlockStatement {} and both arithmetic mutants.
  it('advances one seat clockwise and wraps at the last seat', () => {
    const state = makeState([]);
    expect(nextSeat(state, 2)).toBe(3);
    expect(nextSeat(state, 5)).toBe(0);
  });
});

describe('nextEligibleSeat', () => {
  // Kills UnaryOperator (+1 instead of -1).
  it('returns -1 when no seat holds an eligible player', () => {
    expect(nextEligibleSeat(makeState([]), 0)).toBe(-1);
    expect(
      nextEligibleSeat(makeState([{ id: 'a', seat: 2, stack: 0, status: 'busted' }]), 0)
    ).toBe(-1);
  });

  // Kills EqualityOperator (i < n): the scan must include the starting
  // seat itself as the final candidate after a full wrap.
  it('wraps all the way around to the starting seat itself', () => {
    const state = makeState([{ id: 'a', seat: 2 }]);
    expect(nextEligibleSeat(state, 2)).toBe(2);
  });

  it('skips empty and ineligible seats', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'x', seat: 2, stack: 0, status: 'busted' },
      { id: 'b', seat: 4 },
    ]);
    expect(nextEligibleSeat(state, 0)).toBe(4);
  });
});

describe('computeButton', () => {
  it('returns null with fewer than two eligible players', () => {
    expect(computeButton(makeState([]), null, zeroRand)).toBeNull();
    expect(computeButton(makeState([{ id: 'a', seat: 0 }]), null, zeroRand)).toBeNull();
    // Two seated but only one with chips is still too few.
    expect(
      computeButton(
        makeState([
          { id: 'a', seat: 0 },
          { id: 'x', seat: 1, stack: 0, status: 'busted' },
        ]),
        null,
        zeroRand
      )
    ).toBeNull();
  });

  it('first hand: zeroRand puts the button on the lowest eligible seat; deal order is clockwise from its left with the button last', () => {
    const state = makeState([
      { id: 'a', seat: 1 },
      { id: 'b', seat: 2 },
      { id: 'c', seat: 4 },
    ]);
    const seating = computeButton(state, null, zeroRand)!;
    expect(seating.buttonSeat).toBe(1);
    expect(seating.inHand).toEqual(['b', 'c', 'a']);
  });

  // Kills mutants on the sorted-eligible-seats indexing: randInt picks among
  // the eligible seats in ascending order, not raw seat numbers.
  it('first hand: randInt indexes the ascending list of eligible seats', () => {
    const state = makeState([
      { id: 'a', seat: 1 },
      { id: 'b', seat: 2 },
      { id: 'c', seat: 4 },
    ]);
    const seating = computeButton(state, null, () => 2)!;
    expect(seating.buttonSeat).toBe(4);
    expect(seating.inHand).toEqual(['a', 'b', 'c']);
  });

  it('rotation: the button advances to the next eligible seat, skipping busted and empty seats', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'x', seat: 1, stack: 0, status: 'busted' },
      { id: 'b', seat: 3 },
    ]);
    const seating = computeButton(state, 0, zeroRand)!;
    expect(seating.buttonSeat).toBe(3);
    // The busted player is never dealt in.
    expect(seating.inHand).toEqual(['a', 'b']);
  });

  it('rotation wraps past the highest seat back to the lowest', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'b', seat: 5 },
    ]);
    const seating = computeButton(state, 5, zeroRand)!;
    expect(seating.buttonSeat).toBe(0);
    // Heads-up deal order: non-button first, button last.
    expect(seating.inHand).toEqual(['b', 'a']);
  });

  it('advances off a seat whose occupant busted (the button never sticks)', () => {
    const state = makeState([
      { id: 'x', seat: 1, stack: 0, status: 'busted' },
      { id: 'a', seat: 2 },
      { id: 'b', seat: 4 },
    ]);
    const seating = computeButton(state, 1, zeroRand)!;
    expect(seating.buttonSeat).toBe(2);
    expect(seating.inHand).toEqual(['b', 'a']);
  });

  it('away players are dealt in and can hold the button', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'w', seat: 2, status: 'away' },
      { id: 'b', seat: 4 },
    ]);
    const seating = computeButton(state, 0, zeroRand)!;
    expect(seating.buttonSeat).toBe(2);
    expect(seating.inHand).toEqual(['b', 'a', 'w']);
  });
});
