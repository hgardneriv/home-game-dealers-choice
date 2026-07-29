import { describe, expect, it } from 'vitest';
import { Table, expectError, legalFor } from './test-utils';

// Default layout with zeroRand: first-hand button lands on the lowest eligible
// seat (seat 0 = p0). Hand order is clockwise from the button's left with the
// button last: 3-handed inHand = [p1, p2, p0]. Everyone antes 1 (default) into
// the pot at hand start; every street (including preflop) opens check-or-bet
// with first-to-act = inHand[0] (p1).

describe('game setup and seating flow', () => {
  it('creates a lobby with the host at seat 0 and approves joins', () => {
    const t = new Table(3);
    expect(t.state.phase).toBe('lobby');
    expect(t.seatOf('p0')).toBe(0);
    expect(t.seatOf('p1')).toBe(1);
    expect(t.seatOf('p2')).toBe(2);
    expect(t.state.seatRequests).toHaveLength(0);
  });

  it('requires host approval: request creates a pending entry, deny removes the player', () => {
    const t = new Table(2);
    t.apply({ type: 'requestSeat', playerId: 'px', name: 'Mallory', seat: 3 });
    expect(t.state.seatRequests).toHaveLength(1);
    expect(t.state.players['px'].seat).toBeNull();
    expectError(
      t.tryApply({ type: 'approveSeat', byId: 'p1', playerId: 'px' }),
      'not-host'
    );
    t.apply({ type: 'denySeat', byId: 'p0', playerId: 'px' });
    expect(t.state.players['px']).toBeUndefined();
  });

  it('collects antes at hand start and opens with the player left of the button', () => {
    const t = new Table(3);
    t.start();
    expect(t.state.phase).toBe('playing');
    expect(t.hand.variant).toBe('holdem');
    expect(t.hand.buttonSeat).toBe(0);
    expect(t.hand.inHand).toEqual(['p1', 'p2', 'p0']);
    // Antes live in totalCommitted only — the betting round opens clean.
    expect(t.hand.totalCommitted).toEqual({ p0: 1, p1: 1, p2: 1 });
    expect(t.hand.round.committed).toEqual({});
    expect(t.hand.round.currentBet).toBe(0);
    expect(t.stack('p0')).toBe(19);
    expect(t.stack('p1')).toBe(19);
    expect(t.stack('p2')).toBe(19);
    expect(t.toAct).toBe('p1');
  });

  it('deals everyone exactly two distinct face-down cards from one 52-card deck', () => {
    const t = new Table(6);
    t.start();
    const entries = Object.values(t.hand.playerCards);
    expect(entries).toHaveLength(6);
    for (const pc of entries) expect(pc.faceUp).toEqual([false, false]);
    const all = entries.flatMap((pc) => pc.cards);
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });
});

describe('heads-up order', () => {
  it('the non-button player acts first preflop; the button acts last', () => {
    const t = new Table(2);
    t.start();
    expect(t.hand.buttonSeat).toBe(0);
    expect(t.hand.inHand).toEqual(['p1', 'p0']);
    expect(t.toAct).toBe('p1');
  });

  it('the non-button player acts first on every later street too', () => {
    const t = new Table(2);
    t.start();
    t.act('p1', 'check');
    t.act('p0', 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.toAct).toBe('p1');
  });
});

describe('preflop check-or-bet', () => {
  it('preflop opens with no bet: everyone can check around to the flop', () => {
    const t = new Table(3);
    t.start();
    const legal = legalFor(t.state, 'p1');
    expect(legal.canCheck).toBe(true);
    expect(legal.callAmount).toBe(0);
    expect(legal.canBet).toBe(true);
    expect(legal.canRaise).toBe(false);
    expect(legal.minRaiseTo).toBe(2); // minBet seeds the opening bet
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.hand.board).toHaveLength(3);
    // Only the antes are in the pot.
    expect(Object.values(t.hand.totalCommitted).reduce((a, b) => a + b, 0)).toBe(3);
  });

  it('a preflop bet reopens action to everyone behind', () => {
    const t = new Table(3);
    t.start();
    t.act('p1', 'bet', 2);
    t.act('p2', 'raise', 6);
    expect(t.toAct).toBe('p0');
    t.act('p0', 'fold');
    // p1 still owes the raise.
    expect(t.toAct).toBe('p1');
    expect(legalFor(t.state, 'p1').callAmount).toBe(4);
  });
});

describe('min-raise rules', () => {
  it('bet 2 -> raise to 6 makes the min re-raise 10', () => {
    const t = new Table(3, { stacks: [100, 100, 100] });
    t.start();
    t.act('p1', 'bet', 2);
    t.act('p2', 'raise', 6); // raise size 4
    expectError(t.tryAct('p0', 'raise', 9), 'bad-amount');
    t.act('p0', 'raise', 10);
    expect(t.hand.round.currentBet).toBe(10);
    expect(t.hand.round.lastFullRaiseSize).toBe(4);
  });

  it('every street opening bet minimum is minBet', () => {
    const t = new Table(3);
    t.start();
    expectError(t.tryAct('p1', 'bet', 1), 'bad-amount'); // preflop
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round.street).toBe('flop');
    expectError(t.tryAct('p1', 'bet', 1), 'bad-amount'); // fresh street re-seeds
    t.act('p1', 'bet', 2);
    expect(t.hand.round.currentBet).toBe(2);
  });
});

describe('short all-in raises', () => {
  // Flop scenario: p1 bets 4, p2 calls, p0 goes all-in for 7 (short raise of
  // 3 < 4). Betting must NOT reopen for p1/p2.
  function shortAllInFlop(): Table {
    const t = new Table(3, { stacks: [8, 50, 50] });
    t.start(); // antes: p0 has 7 left
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p0', 'raise', 7); // all-in: 8 stack - 1 ante = 7
    expect(t.hand.allIn).toContain('p0');
    return t;
  }

  it('a short all-in does not reopen betting for players who already acted', () => {
    const t = shortAllInFlop();
    expect(t.toAct).toBe('p1');
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(3);
    expectError(t.tryAct('p1', 'raise', 12), 'illegal-move');
    t.act('p1', 'call');
    t.act('p2', 'call');
    expect(t.hand.round.street).toBe('turn');
  });

  it('a full all-in raise does reopen betting', () => {
    const t = new Table(3, { stacks: [12, 50, 50] });
    t.start(); // antes: p0 has 11 left
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p0', 'raise', 11); // all-in, raise size 7 >= 4: full raise
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(18); // 11 + full raise size 7
  });

  it('cumulative short all-ins totaling a full raise reopen betting', () => {
    // Flop: p1 bets 4; p3 all-in 6 (short +2); p0 all-in 8 (cumulative +4 over
    // the last full bet of 4 => reopened for p1, min-raise basis still 4).
    const t = new Table(4, { stacks: [9, 50, 50, 7] });
    t.start(); // antes: p0 has 8, p3 has 6
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p3', 'check');
    t.act('p0', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p3', 'raise', 6); // short all-in (+2 < 4)
    t.act('p0', 'raise', 8); // short all-in, but cumulatively 8 - 4 >= 4
    const legalP1 = legalFor(t.state, 'p1');
    expect(legalP1.canRaise).toBe(true);
    expect(legalP1.minRaiseTo).toBe(12); // currentBet 8 + last FULL raise size 4
    t.act('p1', 'call');
    t.act('p2', 'call');
    expect(t.hand.round.street).toBe('turn');
  });
});

describe('side pots and refunds', () => {
  it('a one-chip stack antes all-in and only contests the main pot', () => {
    const t = new Table(3, { stacks: [20, 20, 1] });
    t.start();
    expect(t.hand.allIn).toEqual(['p2']);
    expect(t.stack('p2')).toBe(0);
    expect(t.toAct).toBe('p1'); // all-in p2 is skipped
    t.rig(
      { p0: ['Ks', 'Kh'], p1: ['Qc', 'Qd'], p2: ['As', 'Ah'] },
      ['2c', '7d', '9h', '3s', '5d']
    );
    t.act('p1', 'bet', 4);
    t.act('p0', 'call');
    t.checkDown();
    const result = t.hand.result!;
    expect(result.pots.map((p) => p.amount)).toEqual([3, 8]);
    expect(result.pots[0].eligible.sort()).toEqual(['p0', 'p1', 'p2']);
    expect(result.pots[1].eligible.sort()).toEqual(['p0', 'p1']);
    expect(t.stack('p2')).toBe(3); // aces take the main pot only
    expect(t.stack('p0')).toBe(23); // kings take the side pot
    expect(t.stack('p1')).toBe(15);
  });

  it('three-way all-in with stacks 5/12/20: refund, layered pots, correct awards', () => {
    const t = new Table(3, { stacks: [20, 5, 12] });
    t.start(); // antes: 19 / 4 / 11 behind
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'bet', 19); // all-in
    t.act('p1', 'call'); // all-in for 5 total
    t.act('p2', 'call'); // all-in for 12 total
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.refunds['p0']).toBe(8); // 20 - 12 uncalled
    expect(result.pots.map((p) => p.amount)).toEqual([15, 14]);
    expect(result.pots[0].eligible.sort()).toEqual(['p0', 'p1', 'p2']);
    expect(result.pots[1].eligible.sort()).toEqual(['p0', 'p2']);
    // Chips conserved regardless of who won.
    expect(t.stack('p0') + t.stack('p1') + t.stack('p2')).toBe(37);
  });

  it('short stack winning takes only the main pot', () => {
    const t = new Table(3, { stacks: [20, 5, 12] });
    t.start();
    // Rig BEFORE the final call triggers the runout: p1 (short) gets aces,
    // p2 gets kings, p0 queens; board is bricks.
    t.rig(
      { p0: ['Qc', 'Qd'], p1: ['As', 'Ah'], p2: ['Ks', 'Kh'] },
      ['2c', '7d', '9h', '3s', '5c']
    );
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'bet', 19);
    t.act('p1', 'call');
    t.act('p2', 'call');
    expect(t.stack('p1')).toBe(15); // main pot only
    expect(t.stack('p2')).toBe(14); // side pot
    expect(t.stack('p0')).toBe(8); // refund only
  });

  it('a folded contributor’s chips stay in the pot but they cannot win', () => {
    const t = new Table(3, { stacks: [50, 50, 50] });
    t.start();
    t.rig(
      { p0: ['2c', '7d'], p1: ['As', 'Ah'], p2: ['Ks', 'Kh'] },
      ['2d', '8h', '9h', 'Ts', '5c']
    );
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'bet', 10);
    t.act('p1', 'call');
    t.act('p2', 'call');
    // Flop: p1 bets, p2 calls, p0 (a preflop contributor) folds.
    t.act('p1', 'bet', 10);
    t.act('p2', 'call');
    t.act('p0', 'fold');
    t.checkDown();
    const result = t.hand.result!;
    expect(result.pots[0].amount).toBe(53); // includes p0's ante + 10 preflop
    expect(result.pots[0].eligible).not.toContain('p0');
    expect(result.pots[0].winners).toEqual(['p1']);
    expect(t.stack('p1')).toBe(82);
  });
});

describe('fold-around and uncalled bets', () => {
  it('everyone folds: last player wins the antes instantly without showing cards', () => {
    const t = new Table(3);
    t.start();
    t.act('p1', 'fold');
    t.act('p2', 'fold');
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots[0].winners).toEqual(['p0']);
    expect(Object.keys(result.revealed)).toHaveLength(0);
    expect(t.stack('p0')).toBe(22); // won the 3 antes
    expect(t.stack('p1')).toBe(19);
    expect(t.stack('p2')).toBe(19);
  });

  it('an uncalled river bet is returned to the bettor', () => {
    const t = new Table(2, { stacks: [30, 30] });
    t.start(); // antes: pot 2, both have 29 behind
    t.act('p1', 'check');
    t.act('p0', 'check');
    t.checkDownStreets(2); // flop, turn checked through
    expect(t.hand.round.street).toBe('river');
    t.act('p1', 'bet', 10);
    t.act('p0', 'fold');
    // p1 wins the 2 antes; the 10 comes back.
    expect(t.stack('p1')).toBe(31);
    expect(t.stack('p0')).toBe(29);
  });
});

describe('all-in runout', () => {
  it('deals the remaining streets with no further betting and shows down', () => {
    const t = new Table(2, { stacks: [20, 20] });
    t.start();
    t.act('p1', 'bet', 19); // all-in
    t.act('p0', 'call');
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.board).toHaveLength(5);
    expect(t.hand.result).not.toBeNull();
    expect(Object.keys(t.hand.result!.revealed).length).toBeGreaterThan(0);
    expect(t.stack('p0') + t.stack('p1')).toBe(40);
  });
});

describe('split pots and odd chips', () => {
  it('splits a tied pot with the odd chip going to the first winner left of the button', () => {
    const t = new Table(3);
    t.start();
    // Board plays for both: broadway on board, low disjoint hole cards.
    t.rig(
      { p0: ['2c', '3d'], p2: ['2h', '3s'], p1: ['9c', '9d'] },
      ['Ah', 'Kd', 'Qs', 'Jc', 'Td']
    );
    t.act('p1', 'fold'); // their ante stays in the pot
    t.act('p2', 'bet', 2);
    t.act('p0', 'call');
    t.checkDown();
    // Pot = 7 (3 antes + 2 + 2). Split between p0 and p2: p2 is first
    // clockwise from the button (order p1, p2, p0).
    const result = t.hand.result!;
    expect(result.pots[0].winners.sort()).toEqual(['p0', 'p2']);
    expect(t.stack('p2')).toBe(21); // 17 + 4 (extra odd chip)
    expect(t.stack('p0')).toBe(20); // 17 + 3
  });
});

describe('showdown order and auto-muck', () => {
  it('with river betting: aggressor first, callers reveal only if they beat shown hands', () => {
    const t = new Table(3, { stacks: [50, 50, 50] });
    t.start();
    t.rig(
      { p0: ['2c', '7d'], p1: ['Ts', 'Th'], p2: ['As', 'Ad'] },
      ['3d', '8h', '9c', 'Ks', '5c']
    );
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    // Flop / turn check through.
    t.checkDownStreets(2);
    // River: p1 (first to act) bets; p2 and p0 call.
    t.act('p1', 'bet', 5);
    t.act('p2', 'call');
    t.act('p0', 'call');
    const result = t.hand.result!;
    expect(result.showdownOrder[0]).toBe('p1'); // last aggressor
    expect(result.revealed['p1']).toBeDefined();
    expect(result.revealed['p2']).toBeDefined(); // beats p1's tens
    expect(result.revealed['p0']).toBeUndefined(); // king-high mucks
    expect(result.descriptions['p2']).toBe('Pair of Aces');
    expect(result.pots[0].winners).toEqual(['p2']);
  });

  it('river checked around: first player left of the button shows first', () => {
    const t = new Table(3, { stacks: [50, 50, 50] });
    t.start();
    t.rig(
      { p0: ['2c', '7d'], p1: ['Ts', 'Th'], p2: ['As', 'Ad'] },
      ['3d', '8h', '9c', 'Ks', '5c']
    );
    t.checkDown(); // everything checks through
    const result = t.hand.result!;
    expect(result.showdownOrder[0]).toBe('p1'); // seat 1, first left of button
  });
});

describe('button rotation', () => {
  /** Hand 1 of a 4-handed game where p1 (stack 3) busts to p0's aces. */
  function bustP1(): Table {
    const t = new Table(4, { stacks: [50, 3, 50, 50] });
    t.start(); // button 0, order p1, p2, p3, p0; antes leave p1 with 2
    t.rig(
      { p0: ['As', 'Ah'], p1: ['2c', '7d'], p2: ['Kc', 'Kd'], p3: ['3c', '8d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p1', 'bet', 2); // all-in
    t.act('p2', 'fold');
    t.act('p3', 'fold');
    t.act('p0', 'call'); // runout to showdown
    expect(t.state.players['p1'].status).toBe('busted');
    return t;
  }

  it('the button advances one seat and skips the busted seat', () => {
    const t = bustP1();
    t.nextHand();
    expect(t.hand.buttonSeat).toBe(2); // seat 1 (busted) skipped
    expect(t.hand.inHand).toEqual(['p3', 'p0', 'p2']);
    expect(t.hand.inHand).not.toContain('p1');
    expect(t.toAct).toBe('p3'); // left of the button
  });

  it('rotation stays one-eligible-seat-per-hand across an orbit with a bust', () => {
    const t = bustP1();
    const buttons: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.nextHand();
      buttons.push(t.hand.buttonSeat);
      t.foldAround();
    }
    expect(buttons).toEqual([2, 3, 0, 2]);
  });
});

describe('new joiner', () => {
  it('a player seated mid-hand is dealt into the very next hand (no arc exclusion)', () => {
    const t = new Table(3); // seats 0, 1, 2
    t.start(); // hand 1: button 0
    t.apply({ type: 'requestSeat', playerId: 'p9', name: 'Late Larry', seat: 3 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'p9' });
    expect(t.seatOf('p9')).toBe(3);
    expect(t.hand.inHand).not.toContain('p9'); // not in the live hand
    t.foldAround();
    t.nextHand();
    // Hand 2: button seat 1; p9 plays immediately.
    expect(t.hand.buttonSeat).toBe(1);
    expect(t.hand.inHand).toEqual(['p2', 'p9', 'p0', 'p1']);
    expect(t.hand.totalCommitted['p9']).toBe(1); // anted like everyone else
  });
});

describe('timers, time bank, and away players', () => {
  it('rejects timeout before the deadline and consumes the time bank once', () => {
    const t = new Table(3);
    t.start();
    const deadline = t.hand.round.actionDeadline!;
    expectError(t.tryApply({ type: 'timeout' }), 'not-expired');

    t.now = deadline + 1;
    t.apply({ type: 'timeout' }); // first expiry: time bank kicks in
    expect(t.toAct).toBe('p1'); // still their turn
    expect(t.state.players['p1'].timeBankMs).toBe(0);
    expect(t.hand.round.actionDeadline).toBe(deadline + 10_000);

    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // second expiry: preflop check is free
    expect(t.hand.folded).not.toContain('p1');
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.toAct).toBe('p2');
  });

  it('auto-folds when the expiring player faces a bet', () => {
    const t = new Table(3);
    t.start();
    t.act('p1', 'bet', 2);
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // time bank
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // facing a bet: auto-fold
    expect(t.hand.folded).toContain('p2');
    expect(t.state.players['p2'].status).toBe('away');
    expect(t.toAct).toBe('p0');
  });

  it('away players are auto-resolved instantly on their next turns', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p1 auto-checked + away
    t.act('p2', 'fold');
    t.act('p0', 'fold'); // p1 wins hand 1
    t.nextHand(); // hand 2: button seat 1, order p2, p0, p1
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.toAct).toBe('p1');
    expect(t.state.players['p1'].status).toBe('away');
    expect(t.hand.round.actionDeadline).toBe(t.now); // instantly due
  });

  it('imBack restores an away player', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p1 away
    t.apply({ type: 'imBack', playerId: 'p1' });
    expect(t.state.players['p1'].status).toBe('seated');
  });
});

describe('host controls', () => {
  it('pause during a hand takes effect at hand end; resume restarts', () => {
    const t = new Table(3);
    t.start();
    t.apply({ type: 'pause', byId: 'p0' });
    expect(t.state.phase).toBe('playing'); // still finishing the hand
    t.act('p1', 'fold');
    t.act('p2', 'fold');
    expect(t.state.phase).toBe('paused');
    t.apply({ type: 'resume', byId: 'p0' });
    expect(t.state.phase).toBe('hand-over');
    t.nextHand();
    expect(t.state.phase).toBe('playing');
  });

  it('kicking a player folds them and play continues', () => {
    const t = new Table(3);
    t.start();
    expect(t.toAct).toBe('p1');
    expectError(t.tryApply({ type: 'kick', byId: 'p1', playerId: 'p2' }), 'not-host');
    t.apply({ type: 'kick', byId: 'p0', playerId: 'p2' }); // host kicks a bystander
    expect(t.state.players['p2'].status).toBe('kicked');
    expect(t.state.seats[2]).toBeNull();
    expect(t.hand.folded).toContain('p2');
    // Hand continues heads-up between p1 and p0.
    t.act('p1', 'check');
    expect(t.toAct).toBe('p0');
    expect(t.state.phase).toBe('playing');
  });
});

describe('host ends the game', () => {
  it('is host-only, refunds mid-hand chips (antes included), and marks the reason', () => {
    const t = new Table(3);
    t.start();
    t.act('p1', 'bet', 10); // chips in the pot mid-hand
    expectError(t.tryApply({ type: 'endGame', byId: 'p1' }), 'not-host');
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('host');
    expect(t.state.hand).toBeNull();
    // Everyone got their committed chips back — full buy-ins restored.
    expect(t.stack('p0')).toBe(20);
    expect(t.stack('p1')).toBe(20);
    expect(t.stack('p2')).toBe(20);
    expectError(t.tryApply({ type: 'endGame', byId: 'p0' }), 'bad-phase');
  });
});

describe('bots', () => {
  it('host can add bots up to a full table; approving a human evicts the newest bot', () => {
    const t = new Table(1);
    for (let i = 0; i < 5; i++) t.apply({ type: 'addBot', byId: 'p0' });
    expect(t.state.seats.every((s) => s !== null)).toBe(true);
    const botIds = Object.values(t.state.players)
      .filter((p) => p.isBot)
      .map((p) => p.id);
    t.apply({ type: 'requestSeat', playerId: 'h2', name: 'Human Two', seat: 0 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'h2' });
    const evicted = t.state.players[botIds[botIds.length - 1]];
    expect(evicted.seat).toBeNull();
    expect(t.seatOf('h2')).not.toBeNull();
  });
});
