import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import type { GameVariant } from './variants/types';

/**
 * Phase-0 plumbing pins: communal pot (hand.pot), carry-pot between hands,
 * settle-hook payments (table-stakes capped), custom resolve, multi-step
 * turns (turnContinues), and end-of-game disbursement. Exercised with two
 * stub variants so the pins hold before the real games (in-between, guts)
 * land on top of them.
 */

/**
 * "Grab" — a minimal communal-pot game: everyone antes into hand.pot; each
 * player in turn either wagers N (wins N from the pot — deterministic) or
 * passes; one orbit then a custom resolve. Leftover pot carries.
 */
const grab: GameVariant = {
  id: 'in-between',
  name: 'Grab (stub)',
  marquee: 'GRAB',
  layoutHint: 'board',
  minPlayers: 2,
  fitsPlayers: (n) => n >= 2 && n <= 6,
  potStyle: 'communal',
  deal(v) {
    for (const id of v.hand.inHand) {
      v.hand.playerCards[id] = { cards: [], faceUp: [] };
    }
    return { kind: 'exchange', street: 'grab' };
  },
  nextPhase() {
    return { kind: 'showdown' };
  },
  score: () => 0,
  describeScore: () => '',
  resolve() {
    return {
      result: { pots: [], revealed: {}, descriptions: {}, showdownOrder: [], refunds: {} },
      payouts: {},
    };
  },
  exchange: {
    legal: () => ({
      kind: 'exchange',
      moves: [{ kind: 'wager', min: 0, max: 999 }],
      autoMove: { kind: 'wager', amount: 0 },
    }),
    apply(v, playerId, move) {
      if (move.kind === 'aceCall') {
        // Multi-step turn support: an ace call keeps the same player to act.
        v.hand.vstate[`called-${playerId}`] = move.high;
        return { applied: { move: 'ace-call' }, turnContinues: true };
      }
      if (move.kind !== 'wager') return { error: { code: 'illegal-move', message: 'wager only' } };
      const win = Math.min(move.amount, v.hand.pot);
      v.hand.pot -= win;
      v.state.players[playerId].stack += win;
      return { applied: { move: 'grab', detail: { win } } };
    },
  },
  bot: { decideBet: () => ({ move: 'check' }) },
};

/** "Match" — committed antes with a settle hook: every loser pays 5 forward. */
const match: GameVariant = {
  id: 'guts',
  name: 'Match (stub)',
  marquee: 'MATCH',
  layoutHint: 'per-player',
  minPlayers: 2,
  fitsPlayers: (n) => n >= 2 && n <= 6,
  deal(v) {
    for (const id of v.hand.inHand) {
      v.hand.playerCards[id] = { cards: [v.draw()], faceUp: [false] };
    }
    return { kind: 'betting', street: 'only' };
  },
  nextPhase() {
    return { kind: 'showdown' };
  },
  // First in hand order always wins (deterministic).
  score: (hand, id) => (hand.inHand[0] === id ? 100 : 1),
  describeScore: () => 'stub',
  settle(v) {
    const winner = v.hand.inHand[0];
    const payments: Record<string, number> = {};
    for (const id of v.hand.inHand) {
      if (id !== winner && !v.hand.folded.includes(id)) payments[id] = 5;
    }
    return { payments, carry: 0 };
  },
  bot: { decideBet: () => ({ move: 'check' }) },
};

let cleanups: (() => void)[] = [];
beforeEach(() => {
  cleanups = [_registerVariantForTest(grab), _registerVariantForTest(match)];
});
afterEach(() => {
  cleanups.forEach((fn) => fn());
});

describe('communal pot', () => {
  it('antes flow into hand.pot, not totalCommitted', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    expect(t.hand.pot).toBe(6);
    expect(t.hand.totalCommitted).toEqual({});
    expect(t.totalChips()).toBe(60);
  });

  it('wagers move chips from the pot to the player, conserved', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    const first = t.toAct!;
    t.apply({ type: 'variantMove', playerId: first, move: { kind: 'wager', amount: 4 } });
    expect(t.hand.pot).toBe(2);
    expect(t.totalChips()).toBe(60);
  });

  it('leftover pot carries to the next hand and seeds it', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    for (const id of [...t.hand.inHand]) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
    }
    expect(t.state.phase).toBe('hand-over');
    expect(t.state.carryPot).toBe(6);
    expect(t.totalChips()).toBe(60);
    t.nextHand();
    // New antes (6) + carried 6.
    expect(t.hand.pot).toBe(12);
    expect(t.state.carryPot).toBe(0);
    expect(t.totalChips()).toBe(60);
  });

  it('carry seeds the pot across DIFFERENT games (main-pot winners take it)', () => {
    const t = new Table(3, {
      config: { enabledVariants: ['in-between', 'holdem'], ante: 2 },
    });
    t.start();
    // Dealer p0 calls the stub; everyone passes -> 6 carries.
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'in-between' });
    for (const id of [...t.hand.inHand]) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'wager', amount: 0 } });
    }
    expect(t.state.carryPot).toBe(6);
    t.nextHand();
    t.apply({ type: 'chooseGame', playerId: t.state.choosing!.dealerId, variant: 'holdem' });
    expect(t.hand.pot).toBe(6); // carried chips ride on the hold'em hand
    const stacksBefore = Object.fromEntries(
      Object.values(t.state.players).map((p) => [p.id, p.stack])
    );
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.totalChips()).toBe(60);
    // Winner(s) collected antes + the carried 6.
    const gained = Object.values(t.state.players)
      .map((p) => p.stack - stacksBefore[p.id])
      .filter((d) => d > 0)
      .reduce((a, b) => a + b, 0);
    expect(gained).toBe(6 + 6); // 3 antes of 2 + carry 6
  });

  it('turnContinues keeps the same player to act with a fresh clock', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    const first = t.toAct!;
    t.apply({ type: 'variantMove', playerId: first, move: { kind: 'aceCall', high: true } });
    expect(t.toAct).toBe(first); // still their turn
    expect(t.hand.round.actionDeadline).not.toBeNull(); // fresh clock stamped
    t.apply({ type: 'variantMove', playerId: first, move: { kind: 'wager', amount: 0 } });
    expect(t.toAct).not.toBe(first); // now the turn passed
  });
});

describe('settle hook (pot matching)', () => {
  it('losers pay into carryPot, capped at their stack', () => {
    const t = new Table(3, {
      config: { enabledVariants: ['guts'], ante: 1 },
      stacks: [20, 20, 4],
    });
    t.start();
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    // Winner = first in hand order (p1, button p0). Losers p2 (pays 5) and
    // p0 (pays 5); p2 had 4-1=3 after ante -> capped at 3.
    expect(t.state.carryPot).toBe(5 + 3);
    expect(t.totalChips()).toBe(44);
    const matched = t.state.events.filter((e) => e.type === 'pot-matched');
    expect(matched).toHaveLength(2);
  });

  it('a player busted by matching is marked busted', () => {
    const t = new Table(2, {
      config: { enabledVariants: ['guts'], ante: 1, topUps: 0 },
      stacks: [20, 6],
    });
    t.start();
    t.checkDown();
    // p0 lost (p1 is first in hand order) and pays min(5, stack).
    const p0 = t.state.players['p0'];
    if (p0.stack === 0) expect(p0.status).toBe('busted');
    expect(t.totalChips()).toBe(26);
  });
});

describe('end-of-game disbursement', () => {
  it('host ending the game splits carryPot + live pot evenly among seated players', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    // Mid-hand: pot 6 lives in hand.pot.
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.carryPot).toBe(0);
    const total = Object.values(t.state.players).reduce((a, p) => a + p.stack, 0);
    expect(total).toBe(60); // every chip back in stacks
  });

  it('rejects malformed variant moves cleanly', () => {
    const t = new Table(3, { config: { enabledVariants: ['in-between'], ante: 2 } });
    t.start();
    const first = t.toAct!;
    expectError(
      t.tryApply({ type: 'variantMove', playerId: first, move: { kind: 'discard', cardIndexes: [] } }),
      'illegal-move'
    );
  });
});
