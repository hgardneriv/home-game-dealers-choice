import { describe, expect, it } from 'vitest';
import { faceUpHoleCards } from './seat-cards';
import { revealWindowOpen } from './reveal-window';
import { inBetween } from '@/engine/variants/in-between';

const stayed = {
  revealed: { winner: ['As', 'Ah'] },
  hands: {
    winner: ['As', 'Ah'],
    loser: ['2c', '7d'],
  },
};

describe('faceUpHoleCards', () => {
  it('hero always uses their own cards', () => {
    expect(faceUpHoleCards(true, 'loser', ['9c', '9d'], stayed, false)).toEqual(['9c', '9d']);
    expect(faceUpHoleCards(true, 'loser', null, null, false)).toBeUndefined();
  });

  it('no result means opponents stay face-down (backs)', () => {
    expect(faceUpHoleCards(false, 'loser', null, null, false)).toBeUndefined();
    expect(faceUpHoleCards(false, 'loser', null, undefined, false)).toBeUndefined();
  });

  it('a stayed loser with cards only in hands is face-up', () => {
    expect(stayed.revealed).not.toHaveProperty('loser');
    expect(faceUpHoleCards(false, 'loser', null, stayed, false)).toEqual(['2c', '7d']);
  });

  it('a folded player stays down even if a hand list is present', () => {
    const withFold = {
      revealed: {},
      hands: { folded: ['Kd', 'Kc', 'Kh'] },
    };
    expect(faceUpHoleCards(false, 'folded', null, withFold, true)).toBeUndefined();
  });

  it('renders 3-, 5-, and 7-card lists in full', () => {
    const three = ['As', 'Kd', 'Qc'];
    const five = ['As', 'Kd', 'Qc', 'Jh', 'Ts'];
    const seven = ['As', 'Kd', 'Qc', 'Jh', 'Ts', '9c', '8d'];
    for (const cards of [three, five, seven]) {
      const result = { revealed: {}, hands: { p: cards } };
      expect(faceUpHoleCards(false, 'p', null, result, false)).toEqual(cards);
      expect(faceUpHoleCards(false, 'p', null, result, false)).toHaveLength(cards.length);
    }
  });

  it('an uncontested fold-out has nothing to show', () => {
    expect(faceUpHoleCards(false, 'p', null, { hands: {}, revealed: {} }, false)).toBeUndefined();
  });

  it('falls back to revealed when hands omits the player', () => {
    expect(
      faceUpHoleCards(false, 'winner', null, { hands: {}, revealed: { winner: ['Kd', 'Kc'] } }, false)
    ).toEqual(['Kd', 'Kc']);
  });
});

describe('in-between third-card reveal still gates the wager bar', () => {
  const cfg = inBetween.resultReveal!;

  it('does not change the resultReveal window', () => {
    expect(cfg).toMatchObject({ eventType: 'in-between-result', ms: 4000 });
    expect(cfg.shows?.({ third: '7h' })).toBe(true);
    expect(cfg.shows?.({ third: null })).toBe(false);
  });

  it('a third card inside the window blocks the next wager; a pass does not', () => {
    const now = 20_000;
    expect(
      revealWindowOpen(
        [{ type: 'in-between-result', at: now - 1000, data: { third: '7h' } }],
        now,
        cfg
      )
    ).toBe(true);
    expect(
      revealWindowOpen(
        [{ type: 'in-between-result', at: now - 1000, data: { third: null } }],
        now,
        cfg
      )
    ).toBe(false);
    expect(
      revealWindowOpen(
        [{ type: 'in-between-result', at: now - 4000, data: { third: '7h' } }],
        now,
        cfg
      )
    ).toBe(false);
    expect(revealWindowOpen([], now, cfg)).toBe(false);
    expect(revealWindowOpen([{ type: 'in-between-result', at: now - 1, data: { third: 'As' } }], now, undefined)).toBe(
      false
    );
  });
});
