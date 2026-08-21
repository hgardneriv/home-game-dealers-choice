import { describe, expect, it } from 'vitest';
import { topUpAmount } from './topup';
import { DEFAULT_CONFIG, normalizeConfig } from './engine';
import type { TableConfig } from './types';

const cfg = (over: Partial<TableConfig> = {}): TableConfig => ({ ...DEFAULT_CONFIG, ...over });

describe('topUpAmount', () => {
  it('enabled schedule on the $20 stack: $12, then $6, then none', () => {
    const c = cfg({ topUps: 2 });
    expect(topUpAmount(c, 0)).toBe(12);
    expect(topUpAmount(c, 1)).toBe(6);
    expect(topUpAmount(c, 2)).toBe(0); // topUps: 2 exhausted
  });

  it('computes each amount from the first, not by iterative re-rounding', () => {
    const c = cfg({ topUps: 4 });
    // 12, 6, round(12·0.25)=3, round(12·0.125)=1.5→2 (banker-free Math.round)
    expect([0, 1, 2, 3].map((n) => topUpAmount(c, n))).toEqual([12, 6, 3, 2]);
  });

  it('decay 0 keeps top-ups flat', () => {
    const c = cfg({ topUps: 3, topUpDecayPct: 0 });
    expect([0, 1, 2].map((n) => topUpAmount(c, n))).toEqual([12, 12, 12]);
  });

  it('decay 100 kills everything after the first', () => {
    const c = cfg({ topUps: 3, topUpDecayPct: 100 });
    expect(topUpAmount(c, 0)).toBe(12);
    expect(topUpAmount(c, 1)).toBe(0);
  });

  it('an amount below the minimum bet is not offered', () => {
    // Second slot would be round(12·0.1) = 1 < minBet 2.
    const c = cfg({ topUps: 3, topUpDecayPct: 90 });
    expect(topUpAmount(c, 0)).toBe(12);
    expect(topUpAmount(c, 1)).toBe(0);
  });

  it('tiny games never offer a useless top-up', () => {
    // startingStack 2 (the clamp floor): first = round(1.2) = 1 < minBet 2.
    const c = normalizeConfig({ startingStack: 2, topUps: 2 });
    expect(topUpAmount(c, 0)).toBe(0);
  });

  it('disabled and legacy configs offer nothing', () => {
    expect(topUpAmount(cfg({ topUps: 0 }), 0)).toBe(0);
    // A game persisted before the feature existed has no topUps field at all.
    const legacy = { ...DEFAULT_CONFIG } as Partial<TableConfig>;
    delete legacy.topUps;
    delete legacy.topUpDecayPct;
    expect(topUpAmount(legacy as TableConfig, 0)).toBe(0);
  });
});

describe('normalizeConfig top-up fields', () => {
  it('clamps and defaults', () => {
    expect(normalizeConfig({ topUps: -5 }).topUps).toBe(0);
    expect(normalizeConfig({ topUps: 999 }).topUps).toBe(20);
    expect(normalizeConfig({}).topUps).toBe(0);
    expect(normalizeConfig({ topUpDecayPct: -1 }).topUpDecayPct).toBe(0);
    expect(normalizeConfig({ topUpDecayPct: 150 }).topUpDecayPct).toBe(100);
    expect(normalizeConfig({}).topUpDecayPct).toBe(50);
    expect(normalizeConfig({ topUps: 'x' as unknown as number }).topUps).toBe(0);
  });
});
