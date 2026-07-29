import { describe, expect, it } from 'vitest';
import { botDecide, hasFlushDraw, hasOpenEndedDraw, type BotView } from './bot';
import type { BettingLegal, ExchangeLegal } from './types';

/** Neutral rng: zero noise on the 21-roll, max on percentage rolls (no random bluffs/calls). */
const neutralRng = (n: number) => (n === 21 ? 10 : n - 1);

const legal = (over: Partial<BettingLegal> = {}): BettingLegal => ({
  kind: 'betting',
  canFold: true,
  canCheck: false,
  callAmount: 10,
  canBet: false,
  canRaise: true,
  minRaiseTo: 20,
  maxRaiseTo: 60,
  ...over,
});

const view = (over: Partial<BotView>): BotView => ({
  hole: ['2c', '7d'],
  board: [],
  publicCards: {},
  potTotal: 10,
  stack: 50,
  committed: 0,
  legal: legal(),
  activeCount: 2,
  personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0.1 },
  minBet: 2,
  ...over,
});

describe('bot defense (no more survival mode)', () => {
  it('calls a pot-sized bet with top pair', () => {
    const decision = botDecide(
      view({ hole: ['Ah', '9c'], board: ['Ad', '7h', '3c'], potTotal: 10 }),
      neutralRng
    );
    expect(decision.move).not.toBe('fold');
  });

  it('continues with a flush draw against a half-pot bet on the flop', () => {
    const decision = botDecide(
      view({
        hole: ['Kh', '9h'],
        board: ['2h', '7h', 'Ac'],
        potTotal: 20,
        legal: legal({ callAmount: 10 }),
      }),
      neutralRng
    );
    expect(decision.move).not.toBe('fold');
  });

  it('continues with an open-ended straight draw against a small bet', () => {
    const decision = botDecide(
      view({
        hole: ['9c', '8d'],
        board: ['7h', '6s', 'Ac'],
        potTotal: 20,
        legal: legal({ callAmount: 5 }),
      }),
      neutralRng
    );
    expect(decision.move).not.toBe('fold');
  });

  it('still folds trash to a big bet (without a lucky bluff-catch roll)', () => {
    const decision = botDecide(
      view({ hole: ['2c', '7d'], board: ['Kd', '9h', '4s'], potTotal: 10 }),
      neutralRng
    );
    expect(decision.move).toBe('fold');
  });

  it('raises with the nuts-ish', () => {
    const decision = botDecide(
      view({ hole: ['Ah', 'Ad'], board: ['Ac', '7h', '3c'], potTotal: 10 }),
      neutralRng
    );
    expect(decision.move).toBe('raise');
  });

  it('sometimes bluff-catches with a live hand when the roll hits', () => {
    // rng that makes the percentage roll land low (triggering the call).
    const catchRng = (n: number) => (n === 21 ? 10 : 0);
    const decision = botDecide(
      view({ hole: ['Ah', '9c'], board: ['Kd', '9h', '4s'], potTotal: 8, legal: legal({ callAmount: 8 }) }),
      catchRng
    );
    expect(decision.move).toBe('call');
  });

  it('never folds a cheap call (at or below the min bet) with a live hand', () => {
    // Middle pair facing a min bet into a tiny pot: pot odds are bad enough
    // that the strength threshold alone would fold, but the cheap-call floor
    // (callAmount <= minBet with decent equity) keeps the bot in.
    const decision = botDecide(
      view({
        hole: ['9h', '8c'],
        board: ['9d', 'Kh', '2s'],
        potTotal: 2,
        legal: legal({ callAmount: 2 }),
        minBet: 2,
      }),
      neutralRng
    );
    expect(decision.move).toBe('call');
  });
});

describe('non-betting rounds', () => {
  it('checks (defers) when handed an exchange-round legal object', () => {
    const exchange: ExchangeLegal = {
      kind: 'exchange',
      moves: [{ kind: 'discard', min: 0, max: 3 }],
      autoMove: { kind: 'discard', cardIndexes: [] },
    };
    const decision = botDecide(view({ legal: exchange }), neutralRng);
    expect(decision).toEqual({ move: 'check' });
  });
});

describe('draw detection', () => {
  it('detects flush draws only when a hole card participates', () => {
    expect(hasFlushDraw(['Kh', '9h'], ['2h', '7h', 'Ac'])).toBe(true);
    expect(hasFlushDraw(['Kc', '9d'], ['2h', '7h', 'Ah'])).toBe(false); // board-only
  });

  it('detects open-ended draws but not gutshots or edge runs', () => {
    expect(hasOpenEndedDraw(['9c', '8d'], ['7h', '6s', 'Ac'])).toBe(true);
    expect(hasOpenEndedDraw(['9c', '5d'], ['7h', '6s', 'Ac'])).toBe(false); // gutshot
    expect(hasOpenEndedDraw(['Ac', 'Kd'], ['Qh', 'Js', '4c'])).toBe(false); // broadway edge
  });
});
