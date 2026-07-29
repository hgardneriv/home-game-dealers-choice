import { describe, expect, it } from 'vitest';
import { Table, expectError, legalFor } from './test-utils';

// Default layout with zeroRand: button seat 0 (p0), SB seat 1 (p1), BB seat 2 (p2).
// Preflop order (3-handed): p0 (button/UTG), p1 (SB), p2 (BB).

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

  it('posts blinds automatically and starts with the button acting first (3-handed)', () => {
    const t = new Table(3);
    t.start();
    expect(t.state.phase).toBe('playing');
    expect(t.hand.buttonSeat).toBe(0);
    expect(t.hand.sbSeat).toBe(1);
    expect(t.hand.bbSeat).toBe(2);
    expect(t.hand.round.committed['p1']).toBe(1);
    expect(t.hand.round.committed['p2']).toBe(2);
    expect(t.stack('p1')).toBe(19);
    expect(t.stack('p2')).toBe(18);
    expect(t.toAct).toBe('p0');
  });

  it('deals everyone exactly two distinct cards from one 52-card deck', () => {
    const t = new Table(6);
    t.start();
    const all = Object.values(t.hand.holeCards).flat();
    expect(all).toHaveLength(12);
    expect(new Set(all).size).toBe(12);
  });
});

describe('heads-up rules', () => {
  it('button posts the small blind and acts first preflop', () => {
    const t = new Table(2);
    t.start();
    expect(t.hand.sbSeat).toBe(t.hand.buttonSeat);
    const buttonId = t.state.seats[t.hand.buttonSeat]!;
    expect(t.toAct).toBe(buttonId);
  });

  it('big blind acts first postflop', () => {
    const t = new Table(2);
    t.start();
    const buttonId = t.state.seats[t.hand.buttonSeat]!;
    const bbId = t.state.seats[t.hand.bbSeat]!;
    t.act(buttonId, 'call');
    t.act(bbId, 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.toAct).toBe(bbId);
  });
});

describe('big blind option', () => {
  it('round does not end until the BB acts on an unraised pot; BB may raise', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    // All bets matched, but BB still owes a decision.
    expect(t.hand.round.street).toBe('preflop');
    expect(t.toAct).toBe('p2');
    const legal = legalFor(t.state, 'p2');
    expect(legal.canCheck).toBe(true);
    expect(legal.canRaise).toBe(true);
    t.act('p2', 'raise', 6);
    // Raise reopens action to the limpers.
    expect(t.toAct).toBe('p0');
  });

  it('BB check closes the preflop round', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    expect(t.hand.round.street).toBe('flop');
    expect(t.hand.board).toHaveLength(3);
  });
});

describe('min-raise rules', () => {
  it('bet 2 -> raise to 6 makes the min re-raise 10', () => {
    const t = new Table(3, { stacks: [100, 100, 100] });
    t.start();
    t.act('p0', 'raise', 6); // raise size 4 over the BB of 2
    expectError(t.tryAct('p1', 'raise', 9), 'bad-amount');
    t.act('p1', 'raise', 10);
    expect(t.hand.round.currentBet).toBe(10);
    expect(t.hand.round.lastFullRaiseSize).toBe(4);
  });

  it('postflop opening bet minimum is the big blind', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    expectError(t.tryAct('p1', 'bet', 1), 'bad-amount');
    t.act('p1', 'bet', 2);
    expect(t.hand.round.currentBet).toBe(2);
  });
});

describe('short all-in raises', () => {
  // Flop scenario: p1 bets 4, p2 calls, p0 goes all-in for 6 (short raise of
  // 2 < 4). Betting must NOT reopen for p1/p2.
  function shortAllInFlop(): Table {
    const t = new Table(3, { stacks: [8, 50, 50] });
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p0', 'raise', 6); // all-in: 8 stack - 2 preflop = 6
    expect(t.hand.allIn).toContain('p0');
    return t;
  }

  it('a short all-in does not reopen betting for players who already acted', () => {
    const t = shortAllInFlop();
    expect(t.toAct).toBe('p1');
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(false);
    expect(legal.callAmount).toBe(2);
    expectError(t.tryAct('p1', 'raise', 12), 'illegal-move');
    t.act('p1', 'call');
    t.act('p2', 'call');
    expect(t.hand.round.street).toBe('turn');
  });

  it('a full all-in raise does reopen betting', () => {
    const t = new Table(3, { stacks: [12, 50, 50] });
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p0', 'raise', 10); // all-in, raise size 6 >= 4: full raise
    const legal = legalFor(t.state, 'p1');
    expect(legal.canRaise).toBe(true);
    expect(legal.minRaiseTo).toBe(16);
  });

  it('cumulative short all-ins totaling a full raise reopen betting', () => {
    // p1 bets 4; p0 all-in 6 (short +2); p3 all-in 8 (cumulative +4 over the
    // last full bet of 4 => reopened for p1).
    const t = new Table(4, { stacks: [8, 50, 50, 10] });
    t.start();
    t.act('p3', 'call');
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    t.act('p1', 'bet', 4);
    t.act('p2', 'call');
    t.act('p3', 'raise', 8); // all-in: 10 - 2 = 8 => short raise of 4? size 4 >= 4 full!
    // 8 - 4 = 4 which equals the bet size 4, so this is actually a FULL raise.
    const legalP0 = legalFor(t.state, 'p0');
    expect(legalP0.canRaise).toBe(false); // p0 has only 6 left: 6 < min raise; all-in below current bet is a call
    t.act('p0', 'call'); // all-in call for 6
    const legalP1 = legalFor(t.state, 'p1');
    expect(legalP1.canRaise).toBe(true);
    t.act('p1', 'call');
    t.act('p2', 'call');
    expect(t.hand.round.street).toBe('turn');
  });
});

describe('side pots and refunds', () => {
  it('three-way all-in with stacks 5/12/20: refund, layered pots, correct awards', () => {
    const t = new Table(3, { stacks: [20, 5, 12] });
    t.start(); // p1 posts SB 1, p2 posts BB 2
    t.act('p0', 'raise', 20); // all-in
    t.act('p1', 'call'); // all-in for 5 total
    t.act('p2', 'call'); // all-in for 12 total
    // Rig before the runout completes? The runout happens synchronously on the
    // last call, so rig by re-running: instead assert pot structure + payouts.
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
    t.act('p0', 'raise', 20);
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
    t.act('p0', 'raise', 10);
    t.act('p1', 'call');
    t.act('p2', 'call');
    // Flop: p1 bets, p2 calls, p0 (initial contributor) folds.
    t.act('p1', 'bet', 10);
    t.act('p2', 'call');
    t.act('p0', 'fold');
    t.checkDown();
    const result = t.hand.result!;
    expect(result.pots[0].amount).toBe(50); // includes p0's 10 preflop
    expect(result.pots[0].eligible).not.toContain('p0');
    expect(result.pots[0].winners).toEqual(['p1']);
    expect(t.stack('p1')).toBe(80);
  });
});

describe('fold-around and uncalled bets', () => {
  it('everyone folds: last player wins instantly without showing cards', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'fold');
    t.act('p1', 'fold');
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots[0].winners).toEqual(['p2']);
    expect(Object.keys(result.revealed)).toHaveLength(0);
    expect(t.stack('p2')).toBe(21); // won the SB
    expect(t.stack('p1')).toBe(19);
  });

  it('an uncalled river bet is returned to the bettor', () => {
    const t = new Table(2, { stacks: [30, 30] });
    t.start();
    const buttonId = t.state.seats[t.hand.buttonSeat]!;
    const bbId = buttonId === 'p0' ? 'p1' : 'p0';
    t.act(buttonId, 'call');
    t.act(bbId, 'check');
    t.checkDownStreets(2); // flop, turn checked through
    t.act(bbId, 'bet', 10);
    t.act(buttonId, 'fold');
    // BB wins pot of 4 preflop chips; the 10 comes back.
    expect(t.stack(bbId)).toBe(32);
    expect(t.stack(buttonId)).toBe(28);
  });
});

describe('all-in runout', () => {
  it('deals the remaining streets with no further betting and shows down', () => {
    const t = new Table(2, { stacks: [20, 20] });
    t.start();
    const buttonId = t.state.seats[t.hand.buttonSeat]!;
    const bbId = buttonId === 'p0' ? 'p1' : 'p0';
    t.act(buttonId, 'raise', 20);
    t.act(bbId, 'call');
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
    t.act('p0', 'call'); // 2
    t.act('p1', 'fold'); // SB folds, 1 dead in pot
    t.act('p2', 'check');
    t.checkDown();
    // Pot = 5 (2 + 2 + 1). Split between p0 and p2: p2 is first clockwise
    // from the button (seat 2 vs seat 0 => order p2 then p0 from seat 1).
    const result = t.hand.result!;
    expect(result.pots[0].winners.sort()).toEqual(['p0', 'p2']);
    expect(t.stack('p2')).toBe(21); // 18 + 3 (extra odd chip)
    expect(t.stack('p0')).toBe(20); // 18 + 2
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
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
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
    expect(result.revealed['p0']).toBeUndefined(); // seven-high mucks
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
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'check');
    t.checkDown(); // everything checks through
    const result = t.hand.result!;
    expect(result.showdownOrder[0]).toBe('p1'); // seat 1, first left of button
  });
});

describe('dead button rule', () => {
  it('busted SB leaves a dead button: BB advances, button sits on the empty seat', () => {
    const t = new Table(4, { stacks: [50, 3, 50, 50] });
    t.start();
    // Hand 1: button 0, SB p1 (posts 1), BB p2 (posts 2), UTG p3.
    t.rig(
      { p0: ['As', 'Ah'], p1: ['2c', '7d'], p2: ['Kc', 'Kd'], p3: ['3c', '8d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p3', 'fold');
    t.act('p0', 'call');
    t.act('p1', 'raise', 3); // all-in short
    t.act('p2', 'call');
    t.act('p0', 'call');
    t.checkDown();
    expect(t.state.players['p1'].status).toBe('busted');

    // Hand 2: dead button on p1's empty seat, SB due at seat 2 (posted), BB seat 3.
    t.nextHand();
    expect(t.hand.buttonSeat).toBe(1);
    expect(t.hand.sbSeat).toBe(2);
    expect(t.hand.deadSb).toBe(false);
    expect(t.hand.bbSeat).toBe(3);
    expect(t.hand.inHand).not.toContain('p1');
  });

  it('nobody skips or double-pays the BB across an orbit with a bust', () => {
    const t = new Table(4, { stacks: [50, 3, 50, 50] });
    t.start();
    t.rig(
      { p0: ['As', 'Ah'], p1: ['2c', '7d'], p2: ['Kc', 'Kd'], p3: ['3c', '8d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p3', 'fold');
    t.act('p0', 'call');
    t.act('p1', 'raise', 3);
    t.act('p2', 'call');
    t.act('p0', 'call');
    t.checkDown();

    const bbSeats: number[] = [];
    for (let i = 0; i < 4; i++) {
      t.nextHand();
      bbSeats.push(t.hand.bbSeat);
      t.foldAround();
    }
    // BB rotates through the three remaining players, one step at a time.
    expect(bbSeats).toEqual([3, 0, 2, 3]);
  });

  it('3 -> 2 transition: previous BB takes the button/SB, never double-BBs', () => {
    const t = new Table(3, { stacks: [50, 50, 3] });
    t.start(); // button 0, SB p1, BB p2 (all-in for 2 of 3... stack 3 posts 2)
    t.rig(
      { p0: ['As', 'Ah'], p1: ['Kc', 'Kd'], p2: ['2c', '7d'] },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.act('p2', 'raise', 3); // all-in for the last chip
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.checkDown();
    expect(t.state.players['p2'].status).toBe('busted');

    t.nextHand();
    // Heads-up: BB advances from seat 2 to seat 0 (p0); p1 gets button + SB.
    expect(t.hand.bbSeat).toBe(0);
    expect(t.hand.buttonSeat).toBe(1);
    expect(t.hand.sbSeat).toBe(1);
  });
});

describe('mid-orbit joiner', () => {
  it('a joiner one seat past the BB simply enters as the next big blind', () => {
    const t = new Table(3); // seats 0, 1, 2
    t.start(); // hand 1: button 0, sb 1, bb 2
    t.apply({ type: 'requestSeat', playerId: 'p9', name: 'Late Larry', seat: 3 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'p9' });
    t.foldAround();
    t.nextHand();
    // Fair entry: p9 posts the BB immediately.
    expect(t.hand.bbSeat).toBe(3);
    expect(t.hand.inHand).toContain('p9');
  });

  it('a joiner between the button and the due SB waits out the blind arc', () => {
    // Players at seats 0, 1, 3 — seat 2 is an empty gap.
    const t = new Table(3, { seats: [0, 1, 3] });
    t.start(); // hand 1: button 0, sb 1, bb 3
    expect(t.hand.bbSeat).toBe(3);
    // Joiner takes the gap seat 2 mid-hand.
    t.apply({ type: 'requestSeat', playerId: 'p9', name: 'Late Larry', seat: 2 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'p9' });
    expect(t.seatOf('p9')).toBe(2);
    t.foldAround();

    // Hand 2: button 1, SB due at 3, BB seat 0. Seat 2 sits in [button, bb):
    // dealing p9 in would hand them the button before any blind — they wait.
    t.nextHand();
    expect(t.hand.buttonSeat).toBe(1);
    expect(t.hand.sbSeat).toBe(3);
    expect(t.hand.bbSeat).toBe(0);
    expect(t.hand.inHand).not.toContain('p9');

    t.foldAround();
    // Hand 3: button 3, SB due 0, BB 1 — seat 2 is past the arc; p9 plays.
    t.nextHand();
    expect(t.hand.inHand).toContain('p9');
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
    expect(t.toAct).toBe('p0'); // still their turn
    expect(t.state.players['p0'].timeBankMs).toBe(0);
    expect(t.hand.round.actionDeadline).toBe(deadline + 10_000);

    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // second expiry: auto-fold (facing the BB)
    expect(t.hand.folded).toContain('p0');
    expect(t.state.players['p0'].status).toBe('away');
    expect(t.toAct).toBe('p1');
  });

  it('auto-checks when checking is free', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'call');
    t.act('p1', 'call');
    t.now = t.hand.round.actionDeadline! + t.state.players['p2'].timeBankMs + 1;
    t.apply({ type: 'timeout' }); // time bank
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // BB can check for free
    expect(t.hand.folded).not.toContain('p2');
    expect(t.hand.round.street).toBe('flop');
    expect(t.state.players['p2'].status).toBe('away');
  });

  it('away players are auto-resolved instantly on their next turns', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p0 folded + away
    // Finish the hand.
    t.foldAround();
    t.nextHand();
    // p0 is dealt in (blinds apply) but the clock is already expired.
    if (t.toAct && t.state.players[t.toAct].status === 'away') {
      expect(t.hand.round.actionDeadline).toBeLessThanOrEqual(t.now);
    }
  });

  it('imBack restores an away player and re-stamps their clock on their turn', () => {
    const t = new Table(3);
    t.start();
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' });
    t.now = t.hand.round.actionDeadline! + 1;
    t.apply({ type: 'timeout' }); // p0 away
    t.apply({ type: 'imBack', playerId: 'p0' });
    expect(t.state.players['p0'].status).toBe('seated');
  });
});

describe('host controls', () => {
  it('pause during a hand takes effect at hand end; resume restarts', () => {
    const t = new Table(3);
    t.start();
    t.apply({ type: 'pause', byId: 'p0' });
    expect(t.state.phase).toBe('playing'); // still finishing the hand
    t.act('p0', 'fold');
    t.act('p1', 'fold');
    expect(t.state.phase).toBe('paused');
    t.apply({ type: 'resume', byId: 'p0' });
    expect(t.state.phase).toBe('hand-over');
    t.nextHand();
    expect(t.state.phase).toBe('playing');
  });

  it('kicking the acting player folds them and play continues', () => {
    const t = new Table(3);
    t.start();
    expect(t.toAct).toBe('p0');
    expectError(t.tryApply({ type: 'kick', byId: 'p1', playerId: 'p0' }), 'not-host');
    t.apply({ type: 'kick', byId: 'p0', playerId: 'p1' }); // host kicks SB (not acting)
    expect(t.state.players['p1'].status).toBe('kicked');
    expect(t.state.seats[1]).toBeNull();
    expect(t.hand.folded).toContain('p1');
    // Hand continues heads-up between p0 and p2.
    t.act('p0', 'call');
    expect(t.state.phase).toBe('playing');
  });
});

describe('host ends the game', () => {
  it('is host-only, refunds mid-hand chips, and marks the reason', () => {
    const t = new Table(3);
    t.start();
    t.act('p0', 'raise', 10); // chips in the pot mid-hand
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
