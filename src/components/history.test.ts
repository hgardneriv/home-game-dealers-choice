import { describe, expect, it } from 'vitest';
import type { GameEvent } from '@/engine/types';
import { Table } from '@/engine/test-utils';
import { describeEvent } from './history';

const names = (id: string) => ({ a: 'Alice', b: 'Bob', c: 'Carol' })[id] ?? id;

function ev(type: string, data: unknown): GameEvent {
  return { seq: 1, at: 0, type, data };
}

describe('describeEvent hand-result audit trail', () => {
  it('showdown: winner paid, every remaining player’s cards, made hands, and board', () => {
    expect(
      describeEvent(
        ev('hand-result', {
          kind: 'showdown',
          pots: [{ amount: 20, winners: ['a'], eligible: ['a', 'b'] }],
          refunds: {},
          revealed: { a: ['As', 'Ah'] },
          hands: { a: ['As', 'Ah'], b: ['2c', '7d'] },
          showdownOrder: ['a', 'b'],
          descriptions: { a: 'Pair of Aces', b: 'High Card Queen' },
          board: ['4h', '9s', 'Jd', 'Qc', '6h'],
        }),
        names
      )
    ).toEqual([
      'Alice wins $20 with As Ah — Pair of Aces',
      'Bob had 2c 7d — High Card Queen',
      'Board: 4h 9s Jd Qc 6h',
    ]);
  });

  it('draw / guts list the full remaining hand with no board line', () => {
    expect(
      describeEvent(
        ev('hand-result', {
          kind: 'showdown',
          variant: 'guts',
          pots: [{ amount: 3, winners: ['b'], eligible: ['a', 'b'] }],
          refunds: {},
          revealed: { b: ['9s', '9d', '9h'] },
          hands: { a: ['5s', '5d', 'Kh'], b: ['9s', '9d', '9h'] },
          showdownOrder: ['a', 'b'],
          descriptions: { a: 'Pair of Fives', b: 'Three of a Kind, Nines' },
          board: [],
        }),
        names
      )
    ).toEqual([
      'Bob wins $3 with 9s 9d 9h — Three of a Kind, Nines',
      'Alice had 5s 5d Kh — Pair of Fives',
    ]);
  });

  it('side pots list each winner, the mucked contestant, and a pot breakdown', () => {
    expect(
      describeEvent(
        ev('hand-result', {
          kind: 'showdown',
          pots: [
            { amount: 60, winners: ['a'], eligible: ['a', 'b', 'c'] },
            { amount: 40, winners: ['b'], eligible: ['b', 'c'] },
          ],
          refunds: {},
          revealed: { a: ['As', 'Ac'], b: ['Kh', 'Qs'] },
          hands: { a: ['As', 'Ac'], b: ['Kh', 'Qs'], c: ['Jd', '9d'] },
          showdownOrder: ['a', 'b', 'c'],
          descriptions: {
            a: 'Three of a Kind, Aces',
            b: 'Two Pair, Kings and Nines',
            c: 'Two Pair, Nines and Fours',
          },
          board: ['Ah', 'Kd', '9c', '2s', '4h'],
        }),
        names
      )
    ).toEqual([
      'Alice wins $60 with As Ac — Three of a Kind, Aces',
      'Bob wins $40 with Kh Qs — Two Pair, Kings and Nines',
      'Carol had Jd 9d — Two Pair, Nines and Fours',
      'Pots: $60 → Alice; $40 → Bob',
      'Board: Ah Kd 9c 2s 4h',
    ]);
  });

  it('does not list hole cards on anything but a settled hand-result', () => {
    expect(describeEvent(ev('action', { playerId: 'a', move: 'raise', amount: 10 }), names)).toEqual([
      'Alice raises to $10',
    ]);
    expect(
      describeEvent(ev('street-dealt', { street: 'flop', cards: ['4h', '9s', 'Jd'] }), names)
    ).toEqual(['flop: 4h 9s Jd']);
    expect(describeEvent(ev('cards-drawn', { playerId: 'a', count: 2 }), names)).toEqual([
      'Alice draws 2',
    ]);
  });

  it('fold win records the awarded pot as uncontested and does not invent cards', () => {
    expect(
      describeEvent(
        ev('hand-result', {
          kind: 'foldWin',
          pots: [{ amount: 30, winners: ['a'], eligible: ['a'] }],
          refunds: {},
          revealed: {},
          hands: {},
          descriptions: {},
          board: [],
        }),
        names
      )
    ).toEqual(['Alice wins $30 (uncontested)']);
  });

  it('falls back to pot math when payouts are missing (legacy events)', () => {
    expect(
      describeEvent(
        ev('hand-result', {
          kind: 'showdown',
          pots: [{ amount: 101, winners: ['a', 'b'] }],
          revealed: { a: ['As', 'Ah'], b: ['Ad', 'Ac'] },
          descriptions: { a: 'Pair of Aces', b: 'Pair of Aces' },
          board: ['2h', '7s', '9d', '3c', '8h'],
        }),
        names
      )
    ).toEqual([
      'Alice wins $51 with As Ah — Pair of Aces',
      'Bob wins $50 with Ad Ac — Pair of Aces',
      'Board: 2h 7s 9d 3c 8h',
    ]);
  });
});

describe('describeEvent other lines', () => {
  it('still formats the table chatter the history already showed', () => {
    expect(describeEvent(ev('hand-started', { handNo: 3, variantName: 'Hold’em' }), names)).toEqual([
      '— Hand #3: Hold’em —',
    ]);
    expect(describeEvent(ev('turn', { playerId: 'a' }), names)).toEqual([]);
    expect(
      describeEvent(ev('in-between-result', { playerId: 'a', third: '5h', outcome: 'win', amount: 4 }), names)
    ).toEqual(['Alice hits 5h — wins $4']);
  });
});

describe('describeEvent against a settled engine hand', () => {
  it('holdem: lists every remaining hand only after the pot is awarded', () => {
    const t = new Table(2);
    const tableNames = (id: string) => t.state.players[id]?.name ?? id;
    t.start();
    t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);

    const before = t.state.events.flatMap((e) => describeEvent(e, tableNames)).join('\n');
    expect(before).not.toMatch(/As Ah|2c 7d/);

    t.checkDown();

    const result = t.state.events.find((e) => e.type === 'hand-result');
    expect(describeEvent(result!, tableNames)).toEqual([
      'P0 wins $2 with As Ah — Pair of Aces',
      'P1 had 2c 7d — High Card Queen',
      'Board: 4h 9s Jd Qc 6h',
    ]);
  });

  it('five-card draw: lists the full five-card hands and no board', () => {
    const t = new Table(2, { config: { enabledVariants: ['five-draw'] } });
    const tableNames = (id: string) => t.state.players[id]?.name ?? id;
    t.start();
    t.rig({
      p0: ['As', 'Ah', 'Ad', '2c', '3d'],
      p1: ['Ks', 'Qh', 'Jd', '9c', '7s'],
    });
    t.act('p1', 'check');
    t.act('p0', 'check');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } });
    t.apply({ type: 'variantMove', playerId: 'p0', move: { kind: 'discard', cardIndexes: [] } });
    t.checkDown();

    const result = t.state.events.find((e) => e.type === 'hand-result');
    expect(describeEvent(result!, tableNames)).toEqual([
      'P0 wins $2 with As Ah Ad 2c 3d — Three of a Kind, Aces',
      'P1 had Ks Qh Jd 9c 7s — High Card King',
    ]);
  });
});
