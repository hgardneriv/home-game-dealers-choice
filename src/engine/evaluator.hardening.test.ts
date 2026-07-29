import { describe, expect, it } from 'vitest';
import { CATEGORY, evaluate5, evaluate7 } from './evaluator';

const cat = (score: number) => score >> 20;

/**
 * Mutation-hardening tests for the evaluator: comparisons whose ordering
 * flips under surviving mutants (wheel-check corruption, kicker sort loss,
 * pair/two-pair classification, evaluate7 arity guard).
 */

describe('evaluate5 hardening', () => {
  it('K-9-8-7-6 offsuit is high card, not a straight — even a pair of twos beats it', () => {
    // ranks[1] - ranks[4] === 3 here, so a corrupted wheel check would call
    // this a five-high straight.
    const k9876 = evaluate5(['Kd', '9h', '8s', '7c', '6d']);
    expect(cat(k9876)).toBe(CATEGORY.highCard);
    expect(evaluate5(['2c', '2d', '5h', '7s', '9c'])).toBeGreaterThan(k9876);
  });

  it('kicker significance is independent of input card order', () => {
    // Ace-high given in ASCENDING order must still beat king-high given
    // descending — an unsorted values array would pack 3 as the top kicker.
    const aceHigh = evaluate5(['3s', '7h', '8d', '9c', 'Ah']);
    const kingHigh = evaluate5(['Kd', 'Qc', 'Js', '9h', '2s']);
    expect(cat(aceHigh)).toBe(CATEGORY.highCard);
    expect(aceHigh).toBeGreaterThan(kingHigh);
    // Same five cards, opposite input order — identical score.
    expect(aceHigh).toBe(evaluate5(['Ah', '9c', '8d', '7h', '3s']));
  });

  it('a lone pair is never scored as two pair', () => {
    // Real two pair must beat a higher lone pair (a pair misclassified as
    // "two pair" with an ace lead kicker would win)...
    expect(evaluate5(['Qc', 'Qd', '8h', '8s', '3c'])).toBeGreaterThan(
      evaluate5(['Ac', 'Ad', '9h', '8c', '3d'])
    );
    // ...and a lone pair still beats plain high card (which a "everything at
    // this point is two pair" mutant would invert via the ace kicker).
    expect(evaluate5(['2c', '2d', '9h', '7s', '5c'])).toBeGreaterThan(
      evaluate5(['Ac', 'Kd', '9h', '7s', '5c'])
    );
  });
});

describe('evaluate7 hardening', () => {
  it('rejects a 6-card input with the precise arity error', () => {
    expect(() => evaluate7(['Ac', 'Kd', 'Qh', 'Js', 'Tc', '9d'])).toThrow(
      /needs 7 cards, got 6/
    );
  });
});
