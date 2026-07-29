import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, expectError, NOW, zeroRand } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import { dueSweepAction } from '@/server/sweep';
import { rankValue } from './deck';
import type { GameVariant } from './variants/types';

/**
 * Dealer's-choice flow: the 'choosing' phase between hands. Exercised with a
 * stub second variant ("five-draw" id borrowed for the test) so the flow is
 * testable before more real games ship.
 */

const stub: GameVariant = {
  id: 'five-draw',
  name: 'Stub Draw',
  marquee: 'STUB DRAW',
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
  score: (hand, id) => rankValue(hand.playerCards[id].cards[0]),
  describeScore: (s) => `high ${s}`,
  bot: { decideBet: () => ({ move: 'check' }) },
};

let unregister: () => void;
beforeEach(() => {
  unregister = _registerVariantForTest(stub);
});
afterEach(() => {
  unregister();
});

const BOTH = { enabledVariants: ['holdem', 'five-draw'] as ('holdem' | 'five-draw')[] };

describe('entering the choosing phase', () => {
  it('one enabled variant deals straight in — no choosing step', () => {
    const t = new Table(3, { config: { enabledVariants: ['holdem'] } });
    t.start();
    expect(t.state.phase).toBe('playing');
    expect(t.state.choosing).toBeNull();
    expect(t.hand.variant).toBe('holdem');
  });

  it('startGame with two variants parks in choosing with the button occupant as dealer', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    expect(t.state.phase).toBe('choosing');
    expect(t.state.hand).toBeNull();
    // zeroRand: first-hand button lands on the lowest eligible seat (p0).
    expect(t.state.choosing).toMatchObject({
      buttonSeat: 0,
      dealerId: 'p0',
      deadline: NOW + 20_000,
      botChooseAt: null,
    });
    const ev = t.state.events.find((e) => e.type === 'choosing-game');
    expect(ev?.data).toMatchObject({
      dealerId: 'p0',
      buttonSeat: 0,
      options: ['holdem', 'five-draw'],
    });
  });

  it('next hand re-enters choosing with the rotated dealer', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    t.foldAround();
    t.nextHand();
    expect(t.state.phase).toBe('choosing');
    expect(t.state.choosing).toMatchObject({ buttonSeat: 1, dealerId: 'p1' });
  });
});

describe('chooseGame validation', () => {
  function choosingTable() {
    const t = new Table(3, { config: BOTH });
    t.start();
    return t;
  }

  it('only the dealer may pick', () => {
    const t = choosingTable();
    expectError(
      t.tryApply({ type: 'chooseGame', playerId: 'p1', variant: 'holdem' }),
      'not-your-turn'
    );
  });

  it('rejects a variant that is not enabled', () => {
    const t = choosingTable();
    expectError(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'guts' }),
      'illegal-move'
    );
  });

  it('rejects outside the choosing phase', () => {
    const t = new Table(3, { config: { enabledVariants: ['holdem'] } });
    t.start();
    expectError(
      t.tryApply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' }),
      'bad-phase'
    );
  });

  it("the dealer's pick starts that game on the pinned button", () => {
    const t = choosingTable();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'five-draw' });
    expect(t.state.phase).toBe('playing');
    expect(t.state.choosing).toBeNull();
    expect(t.hand.variant).toBe('five-draw');
    expect(t.hand.buttonSeat).toBe(0);
    // Stub deals one card each and runs a single betting street.
    expect(t.hand.playerCards['p1'].cards).toHaveLength(1);
    const chosen = t.state.events.find((e) => e.type === 'game-chosen');
    expect(chosen?.data).toMatchObject({
      dealerId: 'p0',
      variant: 'five-draw',
      variantName: 'Stub Draw',
      auto: false,
    });
  });

  it('an away dealer who picks is marked back', () => {
    const t = choosingTable();
    t.state.players['p0'].status = 'away';
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    expect(t.state.players['p0'].status).toBe('seated');
  });
});

describe('chooseTimeout', () => {
  it('rejects before the deadline', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    expectError(t.tryApply({ type: 'chooseTimeout' }), 'not-expired');
  });

  it('auto-picks repeat-last and marks a human dealer away', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'five-draw' });
    t.foldAround();
    t.nextHand(); // p1's deal now
    expect(t.state.phase).toBe('choosing');
    t.now = t.state.choosing!.deadline + 1;
    t.apply({ type: 'chooseTimeout' });
    // Repeats the previous hand's game, dealer benched as away.
    expect(t.state.phase).toBe('playing');
    expect(t.hand.variant).toBe('five-draw');
    expect(t.state.players['p1'].status).toBe('away');
    const auto = t.state.events.filter((e) => e.type === 'game-chosen').at(-1);
    expect(auto?.data).toMatchObject({ variant: 'five-draw', auto: true });
  });

  it('falls back to the first enabled variant on the very first hand', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.now = t.state.choosing!.deadline + 1;
    t.apply({ type: 'chooseTimeout' });
    expect(t.hand.variant).toBe('holdem');
  });
});

describe('sweep integration', () => {
  it('a bot dealer picks via the sweep after its think delay', () => {
    const t = new Table(2, { config: BOTH });
    // Make p1 a bot and give it the deal by rotating: easiest is to rebuild
    // the choosing state after marking p1 a bot.
    t.state.players['p1'].isBot = true;
    t.start();
    // zeroRand button = seat 0 (p0, human). Play a hand, rotate to p1 (bot).
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    t.foldAround();
    t.nextHand();
    const choosing = t.state.choosing!;
    expect(choosing.dealerId).toBe('p1');
    expect(choosing.botChooseAt).not.toBeNull();

    // Not due yet.
    expect(dueSweepAction(t.state, choosing.botChooseAt! - 1, zeroRand)).toBeNull();
    // Due: the sweep proposes the bot's pick (zeroRand → first option).
    const action = dueSweepAction(t.state, choosing.botChooseAt!, zeroRand);
    expect(action).toMatchObject({ type: 'chooseGame', playerId: 'p1', variant: 'holdem' });
    // And the engine accepts it.
    t.now = choosing.botChooseAt!;
    t.apply(action!);
    expect(t.state.phase).toBe('playing');
  });

  it('an overdue human dealer gets chooseTimeout after the grace period', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    const deadline = t.state.choosing!.deadline;
    expect(dueSweepAction(t.state, deadline + 999, zeroRand)).toBeNull(); // inside grace
    expect(dueSweepAction(t.state, deadline + 1001, zeroRand)).toMatchObject({
      type: 'chooseTimeout',
    });
  });

  it('sweep is quiet while the dealer still has time', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    expect(dueSweepAction(t.state, NOW + 1000, zeroRand)).toBeNull();
  });
});

describe('edge cases', () => {
  it('pause during choosing clears it; resume re-enters choosing', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.apply({ type: 'pause', byId: 'p0' });
    expect(t.state.phase).toBe('paused');
    expect(t.state.choosing).toBeNull();
    t.apply({ type: 'resume', byId: 'p0' });
    t.nextHand();
    expect(t.state.phase).toBe('choosing');
  });

  it('the dealer leaving mid-choose hands the pick to the next seat', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    t.foldAround();
    t.nextHand(); // p1's deal
    expect(t.state.choosing!.dealerId).toBe('p1');
    t.apply({ type: 'leave', playerId: 'p1' });
    expect(t.state.phase).toBe('choosing');
    expect(t.state.choosing!.dealerId).toBe('p2');
  });

  it('a non-dealer leaving keeps the table choosing', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    t.apply({ type: 'leave', playerId: 'p2' });
    expect(t.state.phase).toBe('choosing');
    expect(t.state.choosing!.dealerId).toBe('p0');
  });

  it('dropping below two players during choosing ends the game', () => {
    const t = new Table(2, { config: { ...BOTH, topUps: 0 } });
    t.start();
    t.apply({ type: 'leave', playerId: 'p1' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.choosing).toBeNull();
  });

  it('host endGame during choosing works with no pot to refund', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    const before = ['p0', 'p1', 'p2'].map((id) => t.stack(id));
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(['p0', 'p1', 'p2'].map((id) => t.stack(id))).toEqual(before);
  });

  it('a busted player can still top up during choosing and is dealt in', () => {
    const t = new Table(3, { config: { ...BOTH, ante: 5, minBet: 10 }, stacks: [20, 20, 5] });
    t.start();
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'holdem' });
    // p2 anted all-in with 5; fold the others to p2? Simpler: run to showdown.
    t.checkDown();
    if (t.state.players['p2'].stack === 0 && (t.state.phase as string) !== 'ended') {
      // p2 busted — next entry should be choosing (2 chipped remain).
      if ((t.state.phase as string) === 'hand-over') t.nextHand();
      expect(t.state.phase).toBe('choosing');
      t.topUp('p2');
      expect(t.state.players['p2'].status).toBe('seated');
      expect(t.state.players['p2'].stack).toBeGreaterThan(0);
      // The pick still resolves and p2 is dealt in.
      t.apply({
        type: 'chooseGame',
        playerId: t.state.choosing!.dealerId,
        variant: 'holdem',
      });
      expect(t.hand.inHand).toContain('p2');
    }
  });

  it('chip conservation holds across choosing-phase hands', () => {
    const t = new Table(3, { config: BOTH });
    t.start();
    for (let hand = 0; hand < 4; hand++) {
      if ((t.state.phase as string) === 'choosing') {
        t.apply({
          type: 'chooseGame',
          playerId: t.state.choosing!.dealerId,
          variant: hand % 2 === 0 ? 'holdem' : 'five-draw',
        });
      }
      if ((t.state.phase as string) !== 'playing') break;
      t.checkDown();
      expect(t.totalChips()).toBe(60);
      if ((t.state.phase as string) === 'hand-over') t.nextHand();
      else break;
    }
  });
});
