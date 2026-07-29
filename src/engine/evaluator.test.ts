import { describe, expect, it } from 'vitest';
import { CATEGORY, describe as describeHand, evaluate5, evaluate7 } from './evaluator';

const cat = (score: number) => score >> 20;

describe('evaluate5 categories', () => {
  it('recognizes every category', () => {
    expect(cat(evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts']))).toBe(CATEGORY.straightFlush);
    expect(cat(evaluate5(['9c', '9d', '9h', '9s', '2c']))).toBe(CATEGORY.quads);
    expect(cat(evaluate5(['Kc', 'Kd', 'Kh', '4s', '4c']))).toBe(CATEGORY.fullHouse);
    expect(cat(evaluate5(['Ah', 'Jh', '8h', '5h', '2h']))).toBe(CATEGORY.flush);
    expect(cat(evaluate5(['9c', '8d', '7h', '6s', '5c']))).toBe(CATEGORY.straight);
    expect(cat(evaluate5(['7c', '7d', '7h', 'Ks', '2c']))).toBe(CATEGORY.trips);
    expect(cat(evaluate5(['Ac', 'Ad', '8h', '8s', '2c']))).toBe(CATEGORY.twoPair);
    expect(cat(evaluate5(['Jc', 'Jd', '9h', '5s', '2c']))).toBe(CATEGORY.pair);
    expect(cat(evaluate5(['Ac', 'Jd', '9h', '5s', '2c']))).toBe(CATEGORY.highCard);
  });

  it('scores the wheel (A-5 straight) as five-high, below a six-high straight', () => {
    const wheel = evaluate5(['Ac', '2d', '3h', '4s', '5c']);
    const sixHigh = evaluate5(['2c', '3d', '4h', '5s', '6c']);
    expect(cat(wheel)).toBe(CATEGORY.straight);
    expect(wheel).toBeLessThan(sixHigh);
  });

  it('scores the steel wheel (A-5 straight flush) below a six-high straight flush', () => {
    const steel = evaluate5(['Ah', '2h', '3h', '4h', '5h']);
    const six = evaluate5(['2s', '3s', '4s', '5s', '6s']);
    expect(cat(steel)).toBe(CATEGORY.straightFlush);
    expect(steel).toBeLessThan(six);
  });

  it('does not treat Q-K-A-2-3 as a straight (no wraparound)', () => {
    expect(cat(evaluate5(['Qc', 'Kd', 'Ah', '2s', '3c']))).toBe(CATEGORY.highCard);
  });

  it('orders categories correctly', () => {
    const ascending = [
      evaluate5(['Ac', 'Jd', '9h', '5s', '2c']), // high card
      evaluate5(['2c', '2d', '3h', '4s', '5c']), // pair
      evaluate5(['2c', '2d', '3h', '3s', '4c']), // two pair
      evaluate5(['2c', '2d', '2h', '3s', '4c']), // trips
      evaluate5(['Ac', '2d', '3h', '4s', '5c']), // straight (wheel)
      evaluate5(['2h', '3h', '4h', '5h', '7h']), // flush
      evaluate5(['2c', '2d', '2h', '3s', '3c']), // full house
      evaluate5(['2c', '2d', '2h', '2s', '3c']), // quads
      evaluate5(['Ah', '2h', '3h', '4h', '5h']), // straight flush
    ];
    for (let i = 1; i < ascending.length; i++) {
      expect(ascending[i]).toBeGreaterThan(ascending[i - 1]);
    }
  });
});

describe('evaluate5 kicker tiebreaks', () => {
  it('quads: higher quad wins; equal quads decided by kicker', () => {
    expect(evaluate5(['9c', '9d', '9h', '9s', '2c'])).toBeLessThan(
      evaluate5(['Tc', 'Td', 'Th', 'Ts', '2c'])
    );
    expect(evaluate5(['9c', '9d', '9h', '9s', 'Kc'])).toBeLessThan(
      evaluate5(['9c', '9d', '9h', '9s', 'Ac'])
    );
  });

  it('full house: trips rank dominates the pair rank', () => {
    // Kings full of fours beats queens full of aces.
    expect(evaluate5(['Qc', 'Qd', 'Qh', 'As', 'Ac'])).toBeLessThan(
      evaluate5(['Kc', 'Kd', 'Kh', '4s', '4c'])
    );
  });

  it('flush: compares all five kickers in order', () => {
    expect(evaluate5(['Ah', 'Jh', '8h', '5h', '2h'])).toBeLessThan(
      evaluate5(['As', 'Js', '8s', '5s', '3s'])
    );
    expect(evaluate5(['Ah', 'Jh', '8h', '5h', '2h'])).toBe(
      evaluate5(['Ad', 'Jd', '8d', '5d', '2d'])
    );
  });

  it('two pair: high pair, then low pair, then kicker', () => {
    // Aces and threes beats kings and queens.
    expect(evaluate5(['Kc', 'Kd', 'Qh', 'Qs', 'Ac'])).toBeLessThan(
      evaluate5(['Ac', 'Ad', '3h', '3s', '2c'])
    );
    // Same two pair — kicker decides.
    expect(evaluate5(['Ac', 'Ad', '8h', '8s', '5c'])).toBeLessThan(
      evaluate5(['Ah', 'As', '8c', '8d', '9c'])
    );
  });

  it('pair: pair rank then three kickers', () => {
    expect(evaluate5(['Jc', 'Jd', '9h', '5s', '2c'])).toBeLessThan(
      evaluate5(['Jh', 'Js', '9c', '5d', '3c'])
    );
    expect(evaluate5(['Tc', 'Td', 'Ah', 'Ks', 'Qc'])).toBeLessThan(
      evaluate5(['Jc', 'Jd', '4h', '3s', '2c'])
    );
  });

  it('high card: ace-high beats king-high; full kicker chain compared', () => {
    expect(evaluate5(['Kc', 'Qd', 'Jh', '9s', '7c'])).toBeLessThan(
      evaluate5(['Ac', '7d', '5h', '4s', '2c'])
    );
    expect(evaluate5(['Ac', 'Qd', 'Jh', '9s', '7c'])).toBeLessThan(
      evaluate5(['Ah', 'Qs', 'Jc', '9d', '8c'])
    );
  });
});

describe('evaluate7', () => {
  it('finds the best 5 of 7 (flush hidden among pairs)', () => {
    const score = evaluate7(['Ah', 'Kh', 'Ac', 'Kc', '2h', '7h', '9h']);
    expect(cat(score)).toBe(CATEGORY.flush);
  });

  it('finds a straight using exactly one hole card', () => {
    const score = evaluate7(['9c', '2d', '5h', '6s', '7c', '8d', 'Kc']);
    expect(cat(score)).toBe(CATEGORY.straight);
    expect(describeHand(score)).toBe('Straight, Nine High');
  });

  it('board plays: both players chop when neither hole card improves', () => {
    const board = ['Ah', 'Kd', 'Qs', 'Jc', 'Th'];
    const p1 = evaluate7([...board, '2c', '3d']);
    const p2 = evaluate7([...board, '4h', '5s']);
    expect(p1).toBe(p2);
    expect(cat(p1)).toBe(CATEGORY.straight);
  });

  it('picks two pair from the best combination, not the first', () => {
    // 7 cards holding three pairs — must use the two highest.
    const score = evaluate7(['Ac', 'Ad', '8h', '8s', '2c', '2d', 'Kc']);
    expect(describeHand(score)).toBe('Two Pair, Aces and Eights');
  });

  it('upgrade to full house across board + hole combinations', () => {
    const score = evaluate7(['Ac', 'Ad', 'Kh', 'Ks', 'Kc', '2d', '7c']);
    expect(describeHand(score)).toBe('Full House, Kings over Aces');
  });

  it('rejects wrong card counts', () => {
    expect(() => evaluate7(['Ac', 'Ad', 'Kh'])).toThrow();
  });
});

describe('describe', () => {
  it('names hands correctly', () => {
    expect(describeHand(evaluate5(['As', 'Ks', 'Qs', 'Js', 'Ts']))).toBe('Royal Flush');
    expect(describeHand(evaluate5(['9s', '8s', '7s', '6s', '5s']))).toBe(
      'Straight Flush, Nine High'
    );
    expect(describeHand(evaluate5(['9c', '9d', '9h', '9s', '2c']))).toBe(
      'Four of a Kind, Nines'
    );
    expect(describeHand(evaluate5(['Ah', 'Jh', '8h', '5h', '2h']))).toBe('Flush, Ace High');
    expect(describeHand(evaluate5(['Ac', '2d', '3h', '4s', '5c']))).toBe(
      'Straight, Five High'
    );
    expect(describeHand(evaluate5(['7c', '7d', '7h', 'Ks', '2c']))).toBe(
      'Three of a Kind, Sevens'
    );
    expect(describeHand(evaluate5(['Jc', 'Jd', '9h', '5s', '2c']))).toBe('Pair of Jacks');
    expect(describeHand(evaluate5(['Ac', 'Jd', '9h', '5s', '2c']))).toBe('High Card Ace');
  });
});
