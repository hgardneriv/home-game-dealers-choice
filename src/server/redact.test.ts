import { describe, expect, it } from 'vitest';
import { Table } from '@/engine/test-utils';
import type { Player } from '@/engine/types';
import { redactForPlayer } from './redact';

/**
 * First-ever coverage of the information-leak boundary. The core guarantee:
 * a redacted state NEVER contains the deck or another player's hole cards,
 * and per-viewer fields (myCards, legalActions, yourId) are exactly scoped.
 */

/** 3-handed table with rigged, known cards. Button p0, SB p1, BB p2; p0 acts first preflop. */
function riggedTable(): Table {
  const t = new Table(3);
  t.start();
  t.rig({ p0: ['As', 'Ks'], p1: ['Qh', 'Qd'], p2: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  return t;
}

describe('secret containment', () => {
  it('never serializes deck, deckPos, or holeCards keys', () => {
    const t = riggedTable();
    for (const viewer of ['p0', 'p1', 'p2', null]) {
      const text = JSON.stringify(redactForPlayer(t.state, viewer));
      expect(text).not.toContain('"deck"');
      expect(text).not.toContain('"deckPos"');
      expect(text).not.toContain('"holeCards"');
    }
  });

  it("a player's view contains their own cards but no one else's and no undealt board cards", () => {
    const t = riggedTable();
    const text = JSON.stringify(redactForPlayer(t.state, 'p1'));
    expect(text).toContain('Qh');
    expect(text).toContain('Qd');
    for (const hidden of ['As', 'Ks', '2c', '7d', '4h', '9s', 'Jd', 'Qc', '6h']) {
      expect(text).not.toContain(`"${hidden}"`);
    }
  });

  it('dealt board cards appear for everyone; the rest of the rigged run-out stays hidden', () => {
    const t = riggedTable();
    t.act('p0', 'fold');
    t.act('p1', 'call');
    t.act('p2', 'check'); // flop: 4h 9s Jd
    const view = redactForPlayer(t.state, null);
    expect(view.hand!.board).toEqual(['4h', '9s', 'Jd']);
    const text = JSON.stringify(view);
    expect(text).not.toContain('"Qc"'); // turn not dealt yet
    expect(text).not.toContain('"6h"'); // river not dealt yet
    expect(text).not.toContain('"deck"');
  });

  it('an anonymous viewer (null playerId) gets no cards and no legal actions', () => {
    const t = riggedTable();
    const view = redactForPlayer(t.state, null);
    expect(view.yourId).toBeNull();
    expect(view.hand!.myCards).toBeNull();
    expect(view.hand!.legalActions).toBeNull();
  });

  it('an unknown playerId gets no cards rather than a crash', () => {
    const t = riggedTable();
    const view = redactForPlayer(t.state, 'ghost');
    expect(view.hand!.myCards).toBeNull();
    expect(view.hand!.legalActions).toBeNull();
  });
});

describe('per-viewer scoping', () => {
  it('myCards are exactly the viewer’s rigged hole cards', () => {
    const t = riggedTable();
    expect(redactForPlayer(t.state, 'p1').hand!.myCards).toEqual(['Qh', 'Qd']);
    expect(redactForPlayer(t.state, 'p2').hand!.myCards).toEqual(['2c', '7d']);
  });

  it('legalActions only for the player to act; null for everyone else', () => {
    const t = riggedTable(); // preflop, p0 to act
    const forActor = redactForPlayer(t.state, 'p0');
    expect(forActor.hand!.toAct).toBe('p0');
    expect(forActor.hand!.legalActions).not.toBeNull();
    expect(forActor.hand!.legalActions!.canFold).toBe(true);
    expect(redactForPlayer(t.state, 'p1').hand!.legalActions).toBeNull();
    expect(redactForPlayer(t.state, 'p2').hand!.legalActions).toBeNull();
  });

  it('yourId echoes the viewer', () => {
    const t = riggedTable();
    expect(redactForPlayer(t.state, 'p2').yourId).toBe('p2');
  });
});

describe('hand snapshot fields', () => {
  it('preflop: blinds committed, currentBet, potTotal, street, seats and positions', () => {
    const t = riggedTable();
    const h = redactForPlayer(t.state, 'p0').hand!;
    expect(h.handNo).toBe(1);
    expect(h.buttonSeat).toBe(0);
    expect(h.sbSeat).toBe(1);
    expect(h.bbSeat).toBe(2);
    expect(h.deadSb).toBe(false);
    expect(h.street).toBe('preflop');
    expect(h.board).toEqual([]);
    expect(h.committed).toEqual({ p1: 1, p2: 2 });
    expect(h.totalCommitted).toEqual({ p1: 1, p2: 2 });
    expect(h.potTotal).toBe(3);
    expect(h.currentBet).toBe(2);
    expect(h.inHand).toEqual(expect.arrayContaining(['p0', 'p1', 'p2']));
    expect(h.folded).toEqual([]);
    expect(h.allIn).toEqual([]);
    expect(h.actionDeadline).toBe(t.now + t.state.config.actionTimeMs);
    expect(h.result).toBeNull();
  });

  it('after a fold and a completed street: folded list, reset committed, summed pot', () => {
    const t = riggedTable();
    t.act('p0', 'fold');
    t.act('p1', 'call');
    t.act('p2', 'check');
    const h = redactForPlayer(t.state, 'p1').hand!;
    expect(h.street).toBe('flop');
    expect(h.folded).toEqual(['p0']);
    expect(h.committed).toEqual({});
    expect(h.currentBet).toBe(0);
    expect(h.potTotal).toBe(4);
    expect(h.toAct).toBe('p1');
    expect(redactForPlayer(t.state, 'p1').hand!.legalActions!.canCheck).toBe(true);
  });

  it('reports all-in players', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'raise', 4); // BB all-in; p0 and p1 still to respond
    expect(t.state.phase).toBe('playing');
    const h = redactForPlayer(t.state, 'p0').hand!;
    expect(h.allIn).toEqual(['p2']);
  });

  it('exposes the hand result at hand end while still hiding the deck', () => {
    const t = new Table(2);
    t.start();
    t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    t.act('p0', 'call');
    t.act('p1', 'check');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const view = redactForPlayer(t.state, 'p1');
    expect(view.hand!.result).not.toBeNull();
    const text = JSON.stringify(view);
    expect(text).not.toContain('"deck"');
    expect(text).not.toContain('"holeCards"');
  });
});

describe('players, lobby state, and top-level fields', () => {
  it('lobby: hand is null and top-level fields mirror the state', () => {
    const t = new Table(2);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'PX', seat: 4 });
    const view = redactForPlayer(t.state, 'p0');
    expect(view.hand).toBeNull();
    expect(view.id).toBe('game1');
    expect(view.version).toBe(t.state.version);
    expect(view.phase).toBe('lobby');
    expect(view.hostId).toBe('p0');
    expect(view.config.startingStack).toBe(20);
    expect(view.seats[0]).toBe('p0');
    expect(view.seats[1]).toBe('p1');
    expect(view.seatRequests).toHaveLength(1);
    expect(view.seatRequests[0].playerId).toBe('px');
    expect(view.nextHandAt).toBeNull();
    expect(view.pauseAfterHand).toBe(false);
    expect(view.endedReason).toBeNull();
    expect(view.events.length).toBeGreaterThan(0);
    expect(view.events).toBe(t.state.events);
    expect(Math.abs(view.now - Date.now())).toBeLessThan(2_000);
  });

  it('copies every public player field', () => {
    const t = new Table(2);
    const p = redactForPlayer(t.state, 'p1').players;
    expect(p.p0).toMatchObject({
      id: 'p0',
      name: 'P0',
      seat: 0,
      stack: 20,
      status: 'seated',
      isHost: true,
      isBot: false,
      totalBuyIn: 20,
      topUpsUsed: 0,
    });
    expect(p.p1.isHost).toBe(false);
    expect(p.p1.timeBankMs).toBe(t.state.players.p1.timeBankMs);
  });

  it('passes real totalBuyIn/topUpsUsed through, defaulting only when absent (legacy states)', () => {
    const t = new Table(2);
    t.state.players.p1.totalBuyIn = 32;
    t.state.players.p1.topUpsUsed = 1;
    // Simulate a state persisted before the top-up feature existed.
    delete (t.state.players.p0 as Partial<Player>).totalBuyIn;
    delete (t.state.players.p0 as Partial<Player>).topUpsUsed;
    const p = redactForPlayer(t.state, null).players;
    expect(p.p1.totalBuyIn).toBe(32);
    expect(p.p1.topUpsUsed).toBe(1);
    expect(p.p0.totalBuyIn).toBe(t.state.config.startingStack);
    expect(p.p0.topUpsUsed).toBe(0);
  });
});
