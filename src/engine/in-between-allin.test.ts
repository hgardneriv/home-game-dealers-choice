import { describe, expect, it } from 'vitest';
import { Table } from './test-utils';
import { getLegalActions } from './betting';
import { _registerVariantForTest } from './variants/registry';
import type { GameVariant } from './variants/types';

/**
 * In-between: a player who loses their whole stack mid-hand (wager capped at
 * min(pot, stack) means "bet the pot" can be everything) has NO decision left
 * — their only legal wager would be 0. They must be SKIPPED from that point
 * on: no turns dealt to them, no cards burned for them, no Pass prompt —
 * until the hand ends (pot empty or all-pass orbit) and busts them normally.
 *
 * Play-testing bug 2026-08-01: they were instead dealt a dead pass-only turn
 * every orbit for as long as anyone else kept wagering.
 */

const IB = { enabledVariants: ['in-between'] as ['in-between'], ante: 2 };

/** Rig the CURRENT turn's two up-cards and the third card to come. */
function rigTurn(t: Table, up: [string, string], third: string): void {
  const hand = t.hand;
  hand.board = [...up];
  hand.vstate.awaitingAce = false;
  hand.vstate.aceLow = false;
  hand.deck[hand.deckPos] = third;
}

function wager(t: Table, playerId: string, amount: number) {
  return t.apply({ type: 'variantMove', playerId, move: { kind: 'wager', amount } });
}

/** Current player passes, calling a first-card ace high first if one showed. */
function pass(t: Table, playerId: string) {
  const legal = getLegalActions(t.state, playerId)!;
  if (legal.kind === 'exchange' && legal.moves[0].kind === 'aceCall') {
    t.apply({ type: 'variantMove', playerId, move: { kind: 'aceCall', high: true } });
  }
  return wager(t, playerId, 0);
}

/**
 * 3 players, ante 2 → pot 6. p1 starts with 4 (2 behind after the ante),
 * shoves the 2 on a rigged loser, and hits 0 with the pot still live.
 */
function brokeP1(): Table {
  const t = new Table(3, { config: IB, stacks: [20, 4, 20] });
  t.start();
  expect(t.toAct).toBe('p1'); // left of the seat-0 button opens
  rigTurn(t, ['5s', '9s'], '2h'); // third outside, no rank match → clean loss
  wager(t, 'p1', 2);
  expect(t.stack('p1')).toBe(0);
  expect(t.hand.allIn).toContain('p1');
  return t;
}

describe('a broke in-between player is skipped, not prompted', () => {
  it('the next orbit opens on the first player who still has chips', () => {
    const t = brokeP1();

    // Rest of orbit 1: p2 wagers (and loses) so the orbit is not all-pass,
    // p0 passes to close it.
    expect(t.toAct).toBe('p2');
    rigTurn(t, ['5c', '9c'], '2d');
    wager(t, 'p2', 1);
    pass(t, 'p0');

    // Orbit 2 must skip straight past broke p1 to p2.
    expect(t.state.phase).toBe('playing');
    expect(t.toAct).toBe('p2');
    expect(getLegalActions(t.state, 'p1')).toBeNull();
  });

  it('never deals cards to (or burns cards for) the broke player again', () => {
    const t = brokeP1();

    // Two full orbits of the solvent players keeping the pot alive.
    for (let orbit = 0; orbit < 2; orbit++) {
      expect(t.toAct).toBe('p2');
      rigTurn(t, ['5c', '9c'], '2d');
      wager(t, 'p2', 1);
      pass(t, 'p0');
    }

    const turnsFor = (id: string) =>
      t.state.events.filter(
        (e) => e.type === 'in-between-turn' && (e.data as { playerId: string }).playerId === id
      ).length;
    expect(turnsFor('p1')).toBe(1); // only their original (pre-bust) turn
    expect(turnsFor('p2')).toBeGreaterThanOrEqual(3); // kept playing throughout
  });

  it('an all-pass orbit among the solvent ends the hand and busts them', () => {
    const t = brokeP1();

    // Orbit 1 counted p1's losing wager, so passing it out opens orbit 2.
    pass(t, 'p2');
    pass(t, 'p0');
    expect(t.state.phase).toBe('playing');
    expect(t.toAct).toBe('p2'); // straight past broke p1

    // Orbit 2 is genuinely all-pass — only the solvent owe a decision.
    pass(t, 'p2');
    pass(t, 'p0');

    expect(t.state.phase).not.toBe('playing'); // hand over
    expect(t.state.players['p1'].status).toBe('busted');
    expect(t.state.carryPot).toBe(8); // 6 antes + p1's lost 2 carry on
  });

  it('everyone broke at the ante: the hand ends immediately, no dead orbit', () => {
    // Both players ante their last chips — nobody can wager at all.
    const t = new Table(2, { config: { ...IB, topUps: 0 } });
    t.state.players['p0'].stack = 2;
    t.state.players['p1'].stack = 2;
    t.start();

    // No turn may be dealt; the hand resolves on the spot and the game ends
    // (both busted, no rebuys) with the pot redistributed by endGame.
    expect(t.state.phase).toBe('ended');
    expect(t.state.events.filter((e) => e.type === 'in-between-turn')).toHaveLength(0);
  });

  it('control: emptying the pot still ends the hand and busts the broke player', () => {
    const t = brokeP1();

    expect(t.toAct).toBe('p2');
    rigTurn(t, ['2c', 'Kc'], '8d'); // strictly between → win
    wager(t, 'p2', t.hand.pot);
    expect(t.state.players['p1'].status).toBe('busted');
  });

  it('sitsOut applies to exchange rounds ONLY — betting rounds ignore it', () => {
    // A stub variant (borrowed id) whose sitsOut would bench EVERYONE: its
    // betting round must still run normally, proving the engine consults
    // sitsOut for exchange plans alone.
    const stub: GameVariant = {
      id: 'five-draw',
      name: 'Stub',
      marquee: 'STUB',
      layoutHint: 'per-player',
      minPlayers: 2,
      fitsPlayers: (n) => n >= 2,
      deal(v) {
        for (const id of v.hand.inHand) {
          v.hand.playerCards[id] = { cards: [v.draw()], faceUp: [false] };
        }
        return { kind: 'betting', street: 'only' };
      },
      nextPhase() {
        return { kind: 'showdown' };
      },
      score: () => 1,
      describeScore: () => '',
      exchange: {
        sitsOut: () => true,
        legal: () => {
          throw new Error('stub has no exchange rounds');
        },
        apply: () => ({ error: { code: 'illegal-move', message: 'none' } }),
      },
      bot: { decideBet: () => ({ move: 'check' }) },
    };
    const unregister = _registerVariantForTest(stub);
    try {
      const t = new Table(2, { config: { enabledVariants: ['five-draw'] } });
      t.start();
      expect(t.state.phase).toBe('playing');
      expect(t.toAct).toBe('p1'); // the opener is prompted despite sitsOut
    } finally {
      unregister();
    }
  });
});
