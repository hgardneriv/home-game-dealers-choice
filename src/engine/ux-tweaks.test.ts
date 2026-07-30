import { describe, expect, it } from 'vitest';
import { Table, NOW } from './test-utils';
import { handLabel } from './hand-label';
import { redactForPlayer } from '@/server/redact';

/**
 * Play-testing UX pass (2026-07-29): live hand labels, own-card face-up
 * exposure (stud shading), and the in-between result-reveal pause that holds
 * bots off their turn until the table has seen the previous card.
 *
 * Known-equivalent surviving mutants (scoped Stryker pass, 2026-07-29):
 * - hand-label bestOf `cards.length === 5` fast path → false: the
 *   combination path computes the identical score for 5 cards (perf only).
 * - hand-label `score > best` → `>=`: ties overwrite best with an equal
 *   value — same result.
 * - baseball flip-orbit scan bounds (`i <= n` ↔ `i < n` at the wrap): the
 *   cursor player is never eligible right after acting — they either took
 *   the lead (skipped) or busted (folded) — so probing `from` itself can
 *   never match.
 * - redact `h.round.toAct === playerId` → `true` in the legalActions
 *   ternary: getLegalActions itself returns null for a player not on turn.
 * - hand-label partialLabel `count === 2` → true in the two-pair guard:
 *   groups are count-sorted, so groups[1] holding a pair implies groups[0]
 *   does too — the guard can never be reached falsely.
 * - hand-label defensive shapes (`slice(0, 7)`, five-draw/guts length
 *   checks, the board default): callers only pass legal shapes — holdem is
 *   ≤ 2 + 5 cards, five-draw hands are always 5, guts always 3.
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
    // Partial made groups (2–4 cards) hit the group ladder directly.
    expect(handLabel('seven-stud', ['Ks', 'Kd', 'Kc'])).toBe('Three of a Kind, Kings');
    expect(handLabel('seven-stud', ['Ks', 'Kd', 'Kc', 'Kh'])).toBe('Four of a Kind, Kings');
    // Group order is by count then rank, not by the order cards arrived.
    expect(handLabel('seven-stud', ['2c', '2h', 'Kd', 'Ks'])).toBe('Two Pair, Kings and Twos');
    expect(handLabel('seven-stud', ['Ac', '2c', '2h'])).toBe('Pair of Twos');
    // 5+ up-cards evaluate as real poker hands, not just groups.
    expect(handLabel('seven-stud', ['2h', '5h', '9h', 'Jh', 'Kh'])).toBe('Flush, King High');
    // Six cards: the best five must include the LAST card (combination sweep).
    expect(handLabel('seven-stud', ['2h', '5h', '9h', 'Jh', '2c', 'Kh'])).toBe(
      'Flush, King High'
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
    // A real 5-card evaluation, not just rank groups.
    expect(handLabel('five-draw', ['2h', '5h', '9h', 'Jh', 'Kh'])).toBe('Flush, King High');
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

  it('a pass burns no card, so it opens no reveal window for the next bot', () => {
    const t = new Table(2, { config: IB });
    t.apply({ type: 'addBot', byId: 'p0' });
    t.start();
    expect(t.toAct).toBe('p1');
    t.hand.board = ['2h', 'Kh'];
    t.hand.vstate.awaitingAce = false;
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'wager', amount: 0 } });

    const botId = Object.values(t.state.players).find((p) => p.isBot)!.id;
    expect(t.toAct).toBe(botId);
    expect(t.hand.round.botActAt).toBe(NOW + 800); // no 4s hold after a pass
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
