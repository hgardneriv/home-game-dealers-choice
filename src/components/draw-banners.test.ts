import { describe, expect, it } from 'vitest';
import { Table } from '@/engine/test-utils';
import { redactForPlayer } from '@/server/redact';
import {
  currentDiscardAnnouncement,
  discardAnnouncementCopy,
  drawPromptCopy,
  myDrawMax,
} from './draw-banners';

const DRAW = { enabledVariants: ['five-draw'] as ['five-draw'] };
const GUTS = { enabledVariants: ['guts'] as ['guts'] };

function drawTable(players = 3) {
  const t = new Table(players, { config: DRAW });
  t.start();
  return t;
}

function gutsTable(players = 3) {
  const t = new Table(players, { config: GUTS });
  t.start();
  return t;
}

function checkAround(t: Table) {
  for (const id of t.hand.inHand) {
    if (t.toAct === id) t.act(id, 'check');
  }
}

describe('draw banner copy', () => {
  it('keeps the ActionBar wording and names a stand-pat', () => {
    expect(drawPromptCopy(3)).toBe('Your draw — tap cards on the table to swap (up to 3)');
    expect(discardAnnouncementCopy('Raisin Rita', 3)).toBe('Raisin Rita discarded 3');
    expect(discardAnnouncementCopy('Callin Caryl', 0)).toBe('Callin Caryl stood pat');
  });

  it('reports the discard max only on a draw turn', () => {
    expect(myDrawMax(null)).toBeNull();
    expect(
      myDrawMax({
        kind: 'exchange',
        moves: [{ kind: 'discard', min: 0, max: 2 }, { kind: 'fold' }],
        autoMove: { kind: 'discard', cardIndexes: [] },
      })
    ).toBe(2);
    expect(
      myDrawMax({
        kind: 'betting',
        canFold: true,
        canCheck: true,
        callAmount: 0,
        canBet: true,
        canRaise: false,
        minRaiseTo: 2,
        maxRaiseTo: 20,
      })
    ).toBeNull();
  });
});

describe('currentDiscardAnnouncement', () => {
  it('is silent before anyone draws and on the acting player only via legalActions', () => {
    const t = drawTable();
    checkAround(t);
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    const view = redactForPlayer(t.state, 'p1');
    expect(currentDiscardAnnouncement(view.events, view.hand)).toBeNull();
    expect(myDrawMax(view.hand!.legalActions)).toBe(3);
    expect(myDrawMax(redactForPlayer(t.state, 'p2').hand!.legalActions)).toBeNull();
  });

  it('holds the last discard for every viewer until the next player acts', () => {
    const t = drawTable();
    checkAround(t);
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1] } });
    expect(t.toAct).toBe('p2');

    for (const id of ['p0', 'p1', 'p2'] as const) {
      const view = redactForPlayer(t.state, id);
      expect(currentDiscardAnnouncement(view.events, view.hand)).toEqual({
        playerId: 'p1',
        count: 2,
      });
    }

    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'discard', cardIndexes: [] } });
    const after = redactForPlayer(t.state, 'p0');
    expect(currentDiscardAnnouncement(after.events, after.hand)).toEqual({
      playerId: 'p2',
      count: 0,
    });
  });

  it('clears when the draw street closes into the next betting round', () => {
    const t = drawTable();
    checkAround(t);
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0] } });
    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'discard', cardIndexes: [] } });
    t.apply({ type: 'variantMove', playerId: 'p0', move: { kind: 'discard', cardIndexes: [4] } });
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'second' });
    const view = redactForPlayer(t.state, 'p1');
    expect(currentDiscardAnnouncement(view.events, view.hand)).toBeNull();
  });

  it('ignores a malformed cards-drawn payload', () => {
    const t = drawTable();
    checkAround(t);
    const view = redactForPlayer(t.state, 'p1');
    const bogus = [
      ...view.events,
      { seq: 999, at: view.now, type: 'cards-drawn', data: { playerId: 'p1' } },
    ];
    expect(currentDiscardAnnouncement(bogus, view.hand)).toBeNull();
  });

  it('clears when the next player folds on the guts draw', () => {
    const t = gutsTable();
    checkAround(t);
    t.apply({ type: 'variantMove', playerId: 'p1', move: { kind: 'discard', cardIndexes: [0, 1] } });
    const afterDraw = redactForPlayer(t.state, 'p2');
    expect(currentDiscardAnnouncement(afterDraw.events, afterDraw.hand)).toEqual({
      playerId: 'p1',
      count: 2,
    });

    t.apply({ type: 'variantMove', playerId: 'p2', move: { kind: 'fold' } });
    const afterFold = redactForPlayer(t.state, 'p0');
    expect(currentDiscardAnnouncement(afterFold.events, afterFold.hand)).toBeNull();
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
  });
});
