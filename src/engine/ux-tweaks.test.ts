import { describe, expect, it } from 'vitest';
import { Table, NOW } from './test-utils';
import { handLabel } from './hand-label';
import { redactForPlayer } from '@/server/redact';

/**
 * Play-testing UX pass (2026-07-29): live hand labels, own-card face-up
 * exposure (stud shading), and the in-between result-reveal pause that holds
 * bots off their turn until the table has seen the previous card.
 */

describe('handLabel', () => {
  it('names made hands and stays quiet on high card', () => {
    expect(handLabel('holdem', ['Ah', 'Ad'])).toBe('Pair of Aces');
    expect(handLabel('holdem', ['2c', '7d'], ['4h', '9s', 'Jd'])).toBeNull();
    expect(handLabel('holdem', ['Ah', 'Kh'], ['Qh', 'Jh', 'Th'])).toBe('Royal Flush');
    expect(handLabel('holdem', ['Ah', 'Kd'], ['Qh', 'Jh', 'Th', '2c', '2d'])).toBe(
      'Straight, Ace High'
    );
  });

  it('labels partial stud boards and full seven-card hands', () => {
    expect(handLabel('seven-stud', ['Ks', 'Kd', '2c'])).toBe('Pair of Kings');
    expect(handLabel('seven-stud', ['Ks', 'Kd', '2c', '2h'])).toBe('Two Pair, Kings and Twos');
    expect(handLabel('seven-stud', ['Ks', 'Qd', '2c', '7h'])).toBeNull();
    expect(handLabel('seven-stud', ['Ks', 'Kd', 'Kc', 'Kh', '2c', '3d', '4h'])).toBe(
      'Four of a Kind, Kings'
    );
  });

  it('is wild-aware for baseball (3s and 9s)', () => {
    expect(handLabel('baseball', ['Ah', '3d', '9c'])).toBe('Three of a Kind, Aces');
    expect(handLabel('baseball', ['3d', '9c'])).toBe('Pair of Aces');
    expect(handLabel('baseball', ['3d'])).toBeNull();
    expect(handLabel('baseball', ['Kh', '7c'])).toBeNull();
  });

  it('uses the 3-card evaluator for guts', () => {
    expect(handLabel('guts', ['9h', '9d', '2s'])).toBe('Pair of Nines');
    expect(handLabel('guts', ['Ah', 'Kh', 'Qh'])).toBe('Straight Flush, Ace High');
    expect(handLabel('guts', ['Ah', 'Kd', '2s'])).toBeNull();
  });

  it('labels five-draw hands and never labels in-between or empty hands', () => {
    expect(handLabel('five-draw', ['9h', '9d', '2s', '5c', 'Jd'])).toBe('Pair of Nines');
    expect(handLabel('five-draw', ['9h', '8d', '2s', '5c', 'Jd'])).toBeNull();
    expect(handLabel('in-between', ['9h', '9d'])).toBeNull();
    expect(handLabel('holdem', [])).toBeNull();
  });
});

describe('myFaceUp redaction', () => {
  it("exposes which of YOUR OWN cards are face-up (stud: down, down, up)", () => {
    const t = new Table(2, { config: { enabledVariants: ['seven-stud'] } });
    t.start();
    const view = redactForPlayer(t.state, 'p0');
    expect(view.hand!.myCards).toHaveLength(3);
    expect(view.hand!.myFaceUp).toEqual([false, false, true]);
  });

  it('holdem hole cards are both down; anonymous viewers get null', () => {
    const t = new Table(2);
    t.start();
    expect(redactForPlayer(t.state, 'p0').hand!.myFaceUp).toEqual([false, false]);
    expect(redactForPlayer(t.state, null).hand!.myFaceUp).toBeNull();
  });

  it('no-peek (baseball): parallel to the flipped-only myCards', () => {
    const t = new Table(2, { config: { enabledVariants: ['baseball'] } });
    t.start();
    const flipper = t.toAct!;
    expect(redactForPlayer(t.state, flipper).hand!.myCards).toEqual([]);
    expect(redactForPlayer(t.state, flipper).hand!.myFaceUp).toEqual([]);
    t.apply({ type: 'variantMove', playerId: flipper, move: { kind: 'flip' } });
    const view = redactForPlayer(t.state, flipper);
    expect(view.hand!.myCards).toHaveLength(1);
    expect(view.hand!.myFaceUp).toEqual([true]);
  });
});

describe('in-between result-reveal pause', () => {
  const IB = { enabledVariants: ['in-between'] as ['in-between'], ante: 2 };

  it('a bot next to act waits out the 4s reveal window (plus its think delay)', () => {
    // zeroRand: button seat 0 → hand order [p1(seat1), bot(seat2), p0(seat0)].
    const t = new Table(2, { config: IB });
    t.apply({ type: 'addBot', byId: 'p0' });
    t.start();
    expect(t.toAct).toBe('p1');
    // Rig p1's turn: a wide window, third card inside — outcome irrelevant.
    t.hand.board = ['2h', 'Kh'];
    t.hand.vstate.awaitingAce = false;
    t.hand.deck[t.hand.deckPos] = '7s';
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 2 } });

    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    expect(t.toAct).toBe(botId);
    // reveal (4000) + BOT_DELAY_BASE (800); zeroRand jitter = 0.
    expect(t.hand.round.botActAt).toBe(NOW + 4800);
  });

  it("no recent result (a hand's first turn): normal think delay only", () => {
    // Put p1 at seat 2 so the added bot lands at seat 1 and opens the hand.
    const t = new Table(2, { config: IB, seats: [0, 2] });
    t.apply({ type: 'addBot', byId: 'p0' });
    t.start();
    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    expect(t.toAct).toBe(botId);
    expect(t.hand.round.botActAt).toBe(NOW + 800);
  });
});
