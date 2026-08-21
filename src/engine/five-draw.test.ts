import { describe, expect, it } from 'vitest';
import { Table, expectError, legalFor, REBUY_CONFIG } from './test-utils';
import { chooseDiscards } from './variants/five-draw';
import { getLegalActions } from './betting';
import { redactForPlayer } from '@/server/redact';

/**
 * Five-card draw scenarios. zeroRand geometry: first-hand button = seat 0
 * (p0), hand order [p1, ..., p0], p1 first to act on every round including
 * the draw.
 */

const DRAW = { enabledVariants: ['five-draw'] as ['five-draw'] };

function drawTable(players = 3) {
  const t = new Table(players, { config: DRAW });
  t.start();
  return t;
}

describe('hand flow', () => {
  it('deals five down cards to everyone and opens a betting round', () => {
    const t = drawTable();
    expect(t.hand.variant).toBe('five-draw');
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'first' });
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(5);
      expect(t.hand.playerCards[id].faceUp).toEqual([false, false, false, false, false]);
    }
    expect(t.hand.board).toEqual([]);
    expect(t.toAct).toBe('p1');
    // Deck accounting: 15 cards dealt.
    expect(t.hand.deckPos).toBe(15);
  });

  it('first betting round closes into the draw; draws close into the second round; then showdown', () => {
    const t = drawTable();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.toAct).toBe('p1');
    const legal = getLegalActions(t.state, 'p1')!;
    expect(legal).toMatchObject({
      kind: 'exchange',
      moves: [{ kind: 'discard', min: 0, max: 3 }],
      autoMove: { kind: 'discard', cardIndexes: [] },
    });

    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1, 2] } });
    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'discard', cardIndexes: [] } });
    t.apply({ type: 'variantMove', playerId: 'p0', move: { kind: 'discard', cardIndexes: [4] } });

    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'second' });
    expect(t.hand.discards).toHaveLength(4);
    expect(t.hand.deckPos).toBe(19); // 15 dealt + 4 replacements
    expect(t.hand.playerCards['p1'].cards).toHaveLength(5);

    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.totalChips()).toBe(60);
  });

  it('cards-drawn events are public and name only counts', () => {
    const t = drawTable();
    t.checkDownStreets(0);
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [1, 3] } });
    const ev = t.state.events.filter((e) => e.type === 'cards-drawn').at(-1)!;
    expect(ev.data).toEqual({ playerId: 'p1', count: 2 });
  });

  it('worst case six players drawing three never exhausts the deck', () => {
    const t = drawTable(6);
    // Check the first round closed (p1..p5, then p0).
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p0']) t.act(id, 'check');
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p0']) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'discard', cardIndexes: [0, 1, 2] } });
    }
    expect(t.hand.deckPos).toBe(48); // 30 + 18
    // All live cards remain distinct.
    const all = Object.values(t.hand.playerCards).flatMap((pc) => pc.cards);
    expect(new Set(all).size).toBe(30);
    t.checkDown();
    expect(t.totalChips()).toBe(120);
  });
});

describe('draw validation', () => {
  function atDraw() {
    const t = drawTable();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    return t;
  }

  it('rejects more than three discards', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1, 2, 3] } }),
      'bad-amount'
    );
  });

  it('rejects duplicate and out-of-range indexes', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [1, 1] } }),
      'bad-amount'
    );
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [5] } }),
      'bad-amount'
    );
  });

  it('rejects a draw out of turn and during betting rounds', () => {
    const t = atDraw();
    expectError(
      t.tryApply({ type: 'variantMove', playerId: 'p2', move: { kind: 'discard', cardIndexes: [] } }),
      'not-your-turn'
    );
    const t2 = drawTable();
    expectError(
      t2.tryApply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [] } }),
      'illegal-move'
    );
  });

  it('betting moves are rejected during the draw', () => {
    const t = atDraw();
    expectError(t.tryAct('p1', 'check'), 'illegal-move');
  });

  it('timeout during the draw stands pat and marks the player away', () => {
    const t = atDraw();
    t.now = t.hand.round.actionDeadline! + t.state.players['p1'].timeBankMs + 1;
    t.apply({ type: 'timeout' }); // arms the time bank first
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.hand.playerCards['p1'].cards).toHaveLength(5);
    expect(t.toAct).toBe('p2');
    const ev = t.state.events.filter((e) => e.type === 'cards-drawn').at(-1)!;
    expect(ev.data).toMatchObject({ playerId: 'p1', count: 0 });
  });
});

describe('all-in interactions', () => {
  it('a player all-in from the first betting round still draws', () => {
    const t = new Table(2, { config: { ...DRAW, ante: 1, minBet: 2, ...REBUY_CONFIG }, stacks: [20, 5] });
    t.start();
    // Order: [p1, p0], button p0. p1 opens shoving 4 (stack 5 - 1 ante).
    t.act('p1', 'bet', 4);
    t.act('p0', 'call');
    expect(t.hand.allIn).toContain('p1');
    // Exchange round runs for BOTH — all-in players still draw.
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.toAct).toBe('p1');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0] } });
    t.apply({ type: 'variantMove', playerId: 'p0', move: { kind: 'discard', cardIndexes: [] } });
    // p0 alone can bet — second round is skipped straight to showdown.
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.totalChips()).toBe(25);
  });
});

describe('secrecy', () => {
  it('discards and replacement cards never reach any client', () => {
    const t = drawTable();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1] } });
    const thrown = t.hand.discards;
    expect(thrown).toHaveLength(2);
    for (const viewer of ['p0', 'p2', null]) {
      const json = JSON.stringify(redactForPlayer(t.state, viewer));
      for (const card of thrown) expect(json).not.toContain(card);
      for (const card of t.hand.playerCards['p1'].cards) expect(json).not.toContain(card);
      expect(json).not.toContain('"discards"');
    }
    // p1 sees their own post-draw hand.
    const mine = redactForPlayer(t.state, 'p1');
    expect(mine.hand?.myCards).toEqual(t.hand.playerCards['p1'].cards);
  });
});

describe('bot draw policy (chooseDiscards)', () => {
  it('stands pat on a straight or better', () => {
    expect(chooseDiscards(['4s', '5h', '6d', '7c', '8s'])).toEqual([]);
    expect(chooseDiscards(['2s', '7s', '9s', 'Js', 'Ks'])).toEqual([]);
  });
  it('keeps trips and draws two', () => {
    const picks = chooseDiscards(['9s', '9h', '9d', '2c', '7s']);
    expect(picks.sort()).toEqual([3, 4]);
  });
  it('keeps two pair and draws one', () => {
    expect(chooseDiscards(['9s', '9h', '4d', '4c', '7s'])).toEqual([4]);
  });
  it('keeps a pair and draws three', () => {
    const picks = chooseDiscards(['As', 'Ah', '4d', '7c', '9s']);
    expect(picks.sort()).toEqual([2, 3, 4]);
  });
  it('draws one to a four-flush', () => {
    expect(chooseDiscards(['2s', '7s', '9s', 'Js', 'Kd'])).toEqual([4]);
  });
  it('draws one to an open-ended straight draw', () => {
    const picks = chooseDiscards(['5s', '6h', '7d', '8c', 'Kd']);
    expect(picks).toEqual([4]);
  });
  it('with nothing keeps the two highest and draws three', () => {
    const picks = chooseDiscards(['2s', '5h', '9d', 'Jc', 'Kd']);
    expect(picks.sort()).toEqual([0, 1, 2]);
  });
  it('never proposes more than three discards for any hand shape', () => {
    expect(chooseDiscards(['2s', '5h', '9d', 'Jc', 'Kd']).length).toBeLessThanOrEqual(3);
    expect(chooseDiscards(['As', 'Ah', '4d', '7c', '9s']).length).toBeLessThanOrEqual(3);
  });
});

describe('dealer choice integration', () => {
  it('a dealer can call five-card draw and the whole hand settles', () => {
    const t = new Table(3, { config: { enabledVariants: ['holdem', 'five-draw'] } });
    t.start();
    expect(t.state.phase).toBe('choosing');
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'five-draw' });
    expect(t.hand.variant).toBe('five-draw');
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    for (const id of ['p1', 'p2', 'p0']) {
      t.apply({ type: 'variantMove', playerId: id, move: { kind: 'discard', cardIndexes: [0] } });
    }
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.totalChips()).toBe(60);
    // Legal actions on the second betting round were betting-kind.
    expect(() => legalFor(t.state, 'p0')).toThrow(); // hand over — no one to act
  });
});
