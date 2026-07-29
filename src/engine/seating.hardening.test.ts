import { describe, expect, it } from 'vitest';
import type { GameState, Player, PlayerStatus, TableConfig } from './types';
import { computePositions, isEligible, nextEligibleSeat, nextSeat } from './seating';

/**
 * Mutation-hardening tests for seating.ts. Each test pins a rule a surviving
 * Stryker mutant would break. Pure functions are exercised directly with
 * hand-built state fragments — computePositions only reads config.maxSeats,
 * seats and players.
 */

const zeroRand = () => 0;

interface SeatSpec {
  id: string;
  seat: number;
  stack?: number;
  status?: PlayerStatus;
  hasPlayed?: boolean;
}

function makePlayer(spec: {
  id: string;
  seat?: number | null;
  stack?: number;
  status?: PlayerStatus;
  hasPlayed?: boolean;
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
    hasPlayed: spec.hasPlayed ?? true,
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
  // Kills L15: ConditionalExpression true/false, EqualityOperator variants,
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
  // Kills L25 BlockStatement {} and both L26 arithmetic mutants.
  it('advances one seat clockwise and wraps at the last seat', () => {
    const state = makeState([]);
    expect(nextSeat(state, 2)).toBe(3);
    expect(nextSeat(state, 5)).toBe(0);
  });
});

describe('nextEligibleSeat', () => {
  // Kills L37 UnaryOperator (+1 instead of -1).
  it('returns -1 when no seat holds an eligible player', () => {
    expect(nextEligibleSeat(makeState([]), 0)).toBe(-1);
    expect(
      nextEligibleSeat(makeState([{ id: 'a', seat: 2, stack: 0, status: 'busted' }]), 0)
    ).toBe(-1);
  });

  // Kills L32 EqualityOperator (i < n): the scan must include the starting
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

describe('computePositions', () => {
  // Kills L67 ConditionalExpression false.
  it('returns null with fewer than two eligible players', () => {
    expect(computePositions(makeState([{ id: 'a', seat: 0 }]), null, zeroRand)).toBeNull();
  });

  it('first hand: randInt(0) puts the button on the lowest eligible seat', () => {
    const state = makeState([
      { id: 'a', seat: 1 },
      { id: 'b', seat: 2 },
    ]);
    const pos = computePositions(state, null, zeroRand)!;
    expect(pos.buttonSeat).toBe(1);
    expect(pos.sbSeat).toBe(1); // heads-up: button posts the small blind
    expect(pos.bbSeat).toBe(2);
    expect(pos.deadSb).toBe(false);
  });

  // Kills L95 BooleanLiteral (deadSb = true).
  it('heads-up rotation: BB advances, other player takes button+SB, SB never dead', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'b', seat: 1 },
    ]);
    const pos = computePositions(state, { buttonSeat: 0, sbSeat: 0, bbSeat: 1 }, zeroRand)!;
    expect(pos.bbSeat).toBe(0);
    expect(pos.buttonSeat).toBe(1);
    expect(pos.sbSeat).toBe(1);
    expect(pos.deadSb).toBe(false);
    expect(pos.inHand).toEqual(['a', 'b']); // BB first, clockwise from button
  });

  // Kills L103 LogicalOperator mutants and whole-condition -> true: an
  // ineligible (busted) occupant of the due-SB seat must make the SB dead.
  it('dead-button rule: busted player on the due-SB seat makes the SB dead', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'x', seat: 1, stack: 0, status: 'busted' },
      { id: 'b', seat: 2 },
      { id: 'c', seat: 3 },
    ]);
    const pos = computePositions(state, { buttonSeat: 5, sbSeat: 0, bbSeat: 1 }, zeroRand)!;
    expect(pos.bbSeat).toBe(2); // BB advances one eligible seat
    expect(pos.sbSeat).toBe(1); // SB due where the BB just was — dead
    expect(pos.buttonSeat).toBe(0); // button lands where the SB was due
    expect(pos.deadSb).toBe(true);
    expect(pos.inHand).toEqual(['b', 'c', 'a']);
  });

  // Kills L123 ConditionalExpression true (deadSb forced on) and pins the
  // normal live-SB rotation.
  it('dead-button rule: SB stays live when an eligible veteran sits on the due seat', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'b', seat: 1 },
      { id: 'c', seat: 2 },
    ]);
    const pos = computePositions(state, { buttonSeat: 2, sbSeat: 0, bbSeat: 1 }, zeroRand)!;
    expect(pos.bbSeat).toBe(2);
    expect(pos.sbSeat).toBe(1);
    expect(pos.buttonSeat).toBe(0);
    expect(pos.deadSb).toBe(false);
  });

  // Kills L106 ConditionalExpression false, L106 BlockStatement {}, and
  // L108 BooleanLiteral false.
  it('degenerate wrap: button computed onto the BB seat pulls back to the SB position', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'b', seat: 1 },
      { id: 'c', seat: 4 },
    ]);
    // BB advances from seat 2 to seat 4 — exactly where the button was due.
    const pos = computePositions(state, { buttonSeat: 1, sbSeat: 4, bbSeat: 2 }, zeroRand)!;
    expect(pos.bbSeat).toBe(4);
    expect(pos.sbSeat).toBe(2);
    expect(pos.buttonSeat).toBe(2); // pulled back off the BB seat
    expect(pos.deadSb).toBe(true);
    expect(pos.inHand).toEqual(['c', 'a', 'b']);
  });

  // Kills L121 BlockStatement {}, ConditionalExpression false, BooleanLiteral
  // 'headsUp' and 'deadSb'; L123 ConditionalExpression false, EqualityOperator
  // !==, and the uncovered L123 BooleanLiteral false.
  it('blind-arc: a new player due to post the SB is skipped and the SB goes dead', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'n', seat: 1, hasPlayed: false },
      { id: 'b', seat: 2 },
    ]);
    const pos = computePositions(state, { buttonSeat: 5, sbSeat: 0, bbSeat: 1 }, zeroRand)!;
    expect(pos.bbSeat).toBe(2);
    expect(pos.sbSeat).toBe(1); // occupied by the excluded newcomer
    expect(pos.buttonSeat).toBe(0);
    expect(pos.deadSb).toBe(true);
    expect(pos.inHand).toEqual(['b', 'a']); // newcomer not dealt in
  });

  // Kills L118 ConditionalExpression false (relaxation removed).
  it('blind-arc relaxation: deals everyone in rather than stalling below two players', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'n1', seat: 1, hasPlayed: false },
      { id: 'n2', seat: 2, hasPlayed: false },
    ]);
    // Arc [1, 0) excludes both newcomers, leaving only one dealt player.
    const pos = computePositions(state, { buttonSeat: 0, sbSeat: 1, bbSeat: 5 }, zeroRand)!;
    expect(pos.bbSeat).toBe(0);
    expect(pos.buttonSeat).toBe(1);
    expect(pos.inHand).toEqual(['n2', 'a', 'n1']); // relaxed: all three dealt
  });

  // Kills L118 EqualityOperator (dealt.length <= 2 would relax too eagerly).
  it('blind-arc keeps the exclusion when exactly two dealt players remain', () => {
    const state = makeState([
      { id: 'a', seat: 0 },
      { id: 'n', seat: 1, hasPlayed: false },
      { id: 'b', seat: 5 },
    ]);
    // Arc [1, 5) excludes the newcomer; two veterans remain — no relaxation.
    const pos = computePositions(state, { buttonSeat: 3, sbSeat: 1, bbSeat: 4 }, zeroRand)!;
    expect(pos.bbSeat).toBe(5);
    expect(pos.buttonSeat).toBe(1);
    expect(pos.inHand).toEqual(['b', 'a']);
    expect(pos.inHand).not.toContain('n');
  });
});
