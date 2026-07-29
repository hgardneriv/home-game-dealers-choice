import { describe, expect, it } from 'vitest';
import { Table } from '@/engine/test-utils';
import type { Player } from '@/engine/types';
import { redactForPlayer } from './redact';

/**
 * The information-leak boundary. The core guarantee: a redacted state NEVER
 * contains the deck, the discard pile, another player's face-down cards, or
 * variant scratch state — and per-viewer fields (myCards, legalActions,
 * yourId) are exactly scoped. Face-UP cards are public via publicCards.
 */

/**
 * 3-handed table with rigged, known cards (all face-down). With zeroRand the
 * button lands on seat 0 (p0); antes only, so p1 (left of button) acts first.
 */
function riggedTable(): Table {
  const t = new Table(3);
  t.start();
  t.rig({ p0: ['As', 'Ks'], p1: ['Qh', 'Qd'], p2: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
  return t;
}

describe('secret containment', () => {
  it('never serializes deck, deckPos, playerCards, discards, or vstate keys', () => {
    const t = riggedTable();
    for (const viewer of ['p0', 'p1', 'p2', null]) {
      const text = JSON.stringify(redactForPlayer(t.state, viewer));
      expect(text).not.toContain('"deck"');
      expect(text).not.toContain('"deckPos"');
      expect(text).not.toContain('"playerCards"');
      expect(text).not.toContain('"discards"');
      expect(text).not.toContain('"vstate"');
    }
  });

  it("a player's view contains their own cards but no one else's face-down cards and no undealt board cards", () => {
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
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check'); // flop: 4h 9s Jd
    const view = redactForPlayer(t.state, null);
    expect(view.hand!.board).toEqual(['4h', '9s', 'Jd']);
    const text = JSON.stringify(view);
    expect(text).not.toContain('"Qc"'); // turn not dealt yet
    expect(text).not.toContain('"6h"'); // river not dealt yet
    expect(text).not.toContain('"deck"');
  });

  it('a planted discard never serializes for any viewer', () => {
    const t = riggedTable();
    t.hand.discards.push('Th'); // not in any rigged hand or board
    for (const viewer of ['p0', 'p1', 'p2', null]) {
      const text = JSON.stringify(redactForPlayer(t.state, viewer));
      expect(text).not.toContain('"Th"');
      expect(text).not.toContain('"discards"');
    }
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

describe('face-up cards and card counts', () => {
  it('a face-up card IS public to other players; the same player’s face-down card stays hidden', () => {
    const t = riggedTable();
    t.hand.playerCards.p2.faceUp[0] = true; // 2c flips up; 7d stays down
    for (const viewer of ['p0', 'p1', null]) {
      const view = redactForPlayer(t.state, viewer);
      expect(view.hand!.publicCards).toEqual({ p2: ['2c'] });
      const text = JSON.stringify(view);
      expect(text).toContain('"2c"');
      expect(text).not.toContain('"7d"');
    }
  });

  it('players with no face-up cards are omitted from publicCards entirely', () => {
    const t = riggedTable();
    expect(redactForPlayer(t.state, 'p0').hand!.publicCards).toEqual({});
    t.hand.playerCards.p2.faceUp[1] = true;
    const pub = redactForPlayer(t.state, 'p0').hand!.publicCards;
    expect(Object.keys(pub)).toEqual(['p2']);
    expect(pub.p2).toEqual(['7d']);
  });

  it('cardCounts reports how many cards everyone holds without leaking values', () => {
    const t = riggedTable();
    const view = redactForPlayer(t.state, 'p1');
    expect(view.hand!.cardCounts).toEqual({ p0: 2, p1: 2, p2: 2 });
    // The counts are numbers only — opponents' card strings stay absent.
    const text = JSON.stringify(view);
    expect(text).not.toContain('"As"');
    expect(text).not.toContain('"2c"');
  });
});

describe('per-viewer scoping', () => {
  it('myCards are exactly the viewer’s rigged cards', () => {
    const t = riggedTable();
    expect(redactForPlayer(t.state, 'p1').hand!.myCards).toEqual(['Qh', 'Qd']);
    expect(redactForPlayer(t.state, 'p2').hand!.myCards).toEqual(['2c', '7d']);
  });

  it('legalActions only for the player to act; null for everyone else', () => {
    const t = riggedTable(); // preflop, p1 to act
    const forActor = redactForPlayer(t.state, 'p1');
    expect(forActor.hand!.toAct).toBe('p1');
    const legal = forActor.hand!.legalActions;
    expect(legal).not.toBeNull();
    expect(legal!.kind).toBe('betting');
    if (legal!.kind === 'betting') expect(legal!.canFold).toBe(true);
    expect(redactForPlayer(t.state, 'p0').hand!.legalActions).toBeNull();
    expect(redactForPlayer(t.state, 'p2').hand!.legalActions).toBeNull();
  });

  it('yourId echoes the viewer', () => {
    const t = riggedTable();
    expect(redactForPlayer(t.state, 'p2').yourId).toBe('p2');
  });
});

describe('hand snapshot fields', () => {
  it('first street: antes in the pot, fresh betting round, seats and positions', () => {
    const t = riggedTable();
    const h = redactForPlayer(t.state, 'p0').hand!;
    expect(h.handNo).toBe(1);
    expect(h.variant).toBe('holdem');
    expect(h.buttonSeat).toBe(0);
    expect(h.street).toBe('preflop');
    expect(h.roundKind).toBe('betting');
    expect(h.board).toEqual([]);
    expect(h.committed).toEqual({}); // antes are not street commitment
    expect(h.totalCommitted).toEqual({ p0: 1, p1: 1, p2: 1 });
    expect(h.potTotal).toBe(3);
    expect(h.currentBet).toBe(0); // no blinds — nothing to call yet
    expect(h.inHand).toEqual(expect.arrayContaining(['p0', 'p1', 'p2']));
    expect(h.folded).toEqual([]);
    expect(h.allIn).toEqual([]);
    expect(h.toAct).toBe('p1'); // left of the button acts first
    expect(h.actionDeadline).toBe(t.now + t.state.config.actionTimeMs);
    expect(h.result).toBeNull();
  });

  it('after a fold and a completed street: folded list, reset committed, summed pot', () => {
    const t = riggedTable();
    t.act('p1', 'fold');
    t.act('p2', 'check');
    t.act('p0', 'check');
    const h = redactForPlayer(t.state, 'p2').hand!;
    expect(h.street).toBe('flop');
    expect(h.roundKind).toBe('betting');
    expect(h.folded).toEqual(['p1']);
    expect(h.committed).toEqual({});
    expect(h.currentBet).toBe(0);
    expect(h.potTotal).toBe(3); // antes only — the fold added nothing
    expect(h.toAct).toBe('p2'); // still first-left-of-button on every street
    const legal = redactForPlayer(t.state, 'p2').hand!.legalActions!;
    if (legal.kind === 'betting') expect(legal.canCheck).toBe(true);
    else throw new Error('expected a betting round');
  });

  it('reports all-in players', () => {
    const t = new Table(3, { stacks: [50, 50, 4] });
    t.start();
    t.act('p1', 'check');
    t.act('p2', 'bet', 3); // short stack open-shoves post-ante; others still to respond
    expect(t.state.phase).toBe('playing');
    const h = redactForPlayer(t.state, 'p0').hand!;
    expect(h.allIn).toEqual(['p2']);
  });

  it('revealed cards appear only once a result exists; the deck stays hidden throughout', () => {
    const t = new Table(2);
    t.start();
    t.rig({ p0: ['As', 'Ah'], p1: ['2c', '7d'] }, ['4h', '9s', 'Jd', 'Qc', '6h']);
    // Mid-hand: an anonymous viewer sees no face-down card from anyone.
    expect(JSON.stringify(redactForPlayer(t.state, null))).not.toContain('"As"');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const view = redactForPlayer(t.state, null);
    expect(view.hand!.result).not.toBeNull();
    const text = JSON.stringify(view);
    expect(text).toContain('"As"'); // shown at showdown via result.revealed
    expect(text).toContain('"Ah"');
    expect(text).not.toContain('"deck"');
    expect(text).not.toContain('"playerCards"');
    expect(text).not.toContain('"discards"');
  });
});

describe('players, lobby state, and top-level fields', () => {
  it('lobby: hand is null and top-level fields mirror the state', () => {
    const t = new Table(2);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'PX', seat: 4 });
    const view = redactForPlayer(t.state, 'p0');
    expect(view.hand).toBeNull();
    expect(view.choosing).toBeNull();
    expect(view.id).toBe('game1');
    expect(view.version).toBe(t.state.version);
    expect(view.phase).toBe('lobby');
    expect(view.hostId).toBe('p0');
    expect(view.config.startingStack).toBe(20);
    expect(view.config.ante).toBe(1);
    expect(view.config.minBet).toBe(2);
    expect(view.config.enabledVariants).toEqual(['holdem']);
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
