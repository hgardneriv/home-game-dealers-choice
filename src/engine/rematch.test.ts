import { describe, expect, it } from 'vitest';
import { Table, expectError } from './test-utils';
import { isRematchTable } from './types';

/**
 * Play Now is hosted: false until a human is approved. Play Again then
 * rematches this table. A pending request is not a guest; kicked and left
 * players stay out; host-plus-bots still goes home.
 */

function playNowHost(): Table {
  const t = new Table(1, { config: { topUps: 0 } });
  t.state.hosted = false;
  return t;
}

describe('isRematchTable', () => {
  it('Play Now plus five bots is not a rematch', () => {
    const t = playNowHost();
    for (let i = 0; i < 5; i++) t.apply({ type: 'addBot', byId: 'p0' });
    expect(t.state.seats.every((s) => s !== null)).toBe(true);
    expect(t.state.hosted).toBe(false);
    expect(isRematchTable(t.state)).toBe(false);
  });

  it('a pending seat request is not a rematch', () => {
    const t = playNowHost();
    t.apply({ type: 'addBot', byId: 'p0' });
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 2 });
    expect(t.state.seatRequests).toHaveLength(1);
    expect(t.state.players['guest'].seat).toBeNull();
    expect(t.state.hosted).toBe(false);
    expect(isRematchTable(t.state)).toBe(false);
  });

  it('approving a human flips hosted and evicts a bot when the table is full', () => {
    const t = playNowHost();
    for (let i = 0; i < 5; i++) t.apply({ type: 'addBot', byId: 'p0' });
    const botIds = Object.values(t.state.players)
      .filter((p) => p.isBot)
      .map((p) => p.id);
    const newest = botIds[botIds.length - 1];
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 0 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'guest' });
    expect(t.state.hosted).toBe(true);
    expect(isRematchTable(t.state)).toBe(true);
    expect(t.state.players[newest].seat).toBeNull();
    expect(t.state.players[newest].status).toBe('left');
    expect(t.seatOf('guest')).not.toBeNull();
    expect(t.state.phase).toBe('lobby');
  });
});

describe('Play Again keeps invited humans', () => {
  it('after the host ends the night, reseats the guest and leaves kicked players out', () => {
    const t = playNowHost();
    t.apply({ type: 'addBot', byId: 'p0' });
    const botId = t.state.seats[1]!;
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 2 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'guest' });
    t.apply({ type: 'requestSeat', playerId: 'trouble', name: 'Trouble', seat: 3 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'trouble' });
    t.apply({ type: 'requestSeat', playerId: 'walker', name: 'Walker', seat: 4 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'walker' });
    t.apply({ type: 'kick', byId: 'p0', playerId: 'trouble' });
    t.apply({ type: 'leave', playerId: 'walker' });
    t.start();
    t.state.players['guest'].stack = 4;
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('host');
    // A leftover communal fund on an already-ended night must not survive rematch.
    t.state.carryPot = 9;
    t.state.choosing = {
      buttonSeat: 0,
      dealerId: 'p0',
      deadline: 1,
      botChooseAt: null,
    };

    t.apply({ type: 'playAgain', playerId: 'guest' });
    expect(t.state.phase).toBe('lobby');
    expect(t.state.hosted).toBe(true);
    expect(t.state.hand).toBeNull();
    expect(t.state.choosing).toBeNull();
    expect(t.state.carryPot).toBe(0);
    expect(t.state.endedReason).toBeNull();
    expect(t.seatOf('guest')).toBe(2);
    expect(t.stack('guest')).toBe(20);
    expect(t.state.players['guest'].status).toBe('seated');
    expect(t.state.players['guest'].totalBuyIn).toBe(20);
    expect(t.state.players['trouble'].status).toBe('kicked');
    expect(t.state.players['trouble'].seat).toBeNull();
    expect(t.state.seats).not.toContain('trouble');
    expect(t.state.players['walker'].status).toBe('left');
    expect(t.state.players['walker'].seat).toBeNull();
    expect(t.state.players[botId].status).toBe('seated');
    expect(t.stack(botId)).toBe(20);
    expect(t.stack('p0')).toBe(20);
  });

  it('after humansOut, reseats busted guests at the buy-in', () => {
    const t = playNowHost();
    t.apply({ type: 'addBot', byId: 'p0' });
    t.apply({ type: 'addBot', byId: 'p0' });
    const [b1, b2] = t.state.seats.slice(1, 3) as [string, string];
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 3 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'guest' });
    t.state.players[b1].stack = 200;
    t.state.players[b2].stack = 200;
    t.start();

    // Button seat 0. inHand starts at seat 1: b1, b2, guest, host.
    t.rig(
      {
        p0: ['2c', '7d'],
        guest: ['3c', '8d'],
        [b1]: ['As', 'Ah'],
        [b2]: ['Ks', 'Kd'],
      },
      ['4h', '9s', 'Jd', 'Qc', '6h']
    );
    expect(t.toAct).toBe(b1);
    t.act(b1, 'bet', 19);
    t.act(b2, 'fold');
    t.act('guest', 'call');
    t.act('p0', 'call');

    expect(t.state.phase).toBe('ended');
    expect(t.state.endedReason).toBe('humansOut');
    expect(t.state.players['p0'].status).toBe('busted');
    expect(t.state.players['guest'].status).toBe('busted');
    expect(t.stack('p0')).toBe(0);
    expect(t.stack('guest')).toBe(0);

    t.apply({ type: 'playAgain', playerId: 'p0' });
    expect(t.state.phase).toBe('lobby');
    expect(t.state.hosted).toBe(true);
    expect(t.state.players['guest'].status).toBe('seated');
    expect(t.state.players['p0'].status).toBe('seated');
    expect(t.stack('guest')).toBe(20);
    expect(t.stack('p0')).toBe(20);
    expect(t.state.players['guest'].totalBuyIn).toBe(20);
    expect(t.seatOf('guest')).toBe(3);
    expect(t.state.players[b1].status).toBe('seated');
    expect(t.stack(b1)).toBe(20);
  });

  it('a pre-fix state with hosted false and a seated guest still rematches', () => {
    const t = new Table(2, { config: { topUps: 0, ante: 2, minBet: 4 } });
    t.state.hosted = false;
    expect(isRematchTable(t.state)).toBe(true);
    t.start();
    t.state.players['p1'].stack = 3;
    t.apply({ type: 'endGame', byId: 'p0' });
    t.apply({ type: 'playAgain', playerId: 'p1' });
    expect(t.state.phase).toBe('lobby');
    expect(t.state.hosted).toBe(true);
    expect(t.seatOf('p1')).toBe(1);
    expect(t.stack('p1')).toBe(20);
    expect(t.state.players['p1'].status).toBe('seated');
    // The next night uses the hosted path, not a fresh quick-play table.
    t.apply({ type: 'endGame', byId: 'p0' });
    t.apply({ type: 'playAgain', playerId: 'p0' });
    expect(t.state.hosted).toBe(true);
    expect(t.state.phase).toBe('lobby');
  });

  it('pure quick play still is not a rematch, so Play Again links home', () => {
    const t = playNowHost();
    for (let i = 0; i < 3; i++) t.apply({ type: 'addBot', byId: 'p0' });
    t.start();
    t.apply({ type: 'endGame', byId: 'p0' });
    expect(isRematchTable(t.state)).toBe(false);
    expectError(t.tryApply({ type: 'playAgain', playerId: 'p0' }), 'bad-phase');
    expect(t.state.phase).toBe('ended');
    expect(t.state.hosted).toBe(false);
  });
});

describe('approving a guest mid-night does not restart the hand', () => {
  it('during choosing, an open seat just flips hosted', () => {
    const t = new Table(2, {
      config: { enabledVariants: ['holdem', 'five-draw'], topUps: 0 },
    });
    t.state.hosted = false;
    t.start();
    expect(t.state.phase).toBe('choosing');
    const choosing = structuredClone(t.state.choosing);
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 4 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'guest' });
    expect(t.state.hosted).toBe(true);
    expect(t.state.phase).toBe('choosing');
    expect(t.state.hand).toBeNull();
    expect(t.state.choosing).toEqual(choosing);
    expect(t.seatOf('guest')).toBe(4);
    expect(t.state.players['p0'].stack).toBe(20);
    expect(t.state.players['p1'].stack).toBe(20);
  });

  it('during a draw street, the exchange round keeps its actor', () => {
    const t = new Table(3, {
      config: { enabledVariants: ['five-draw'], topUps: 0 },
    });
    t.state.hosted = false;
    t.start();
    t.act('p1', 'check');
    t.act('p2', 'check');
    t.act('p0', 'check');
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    const toAct = t.toAct;
    const handNo = t.hand.handNo;
    const deckPos = t.hand.deckPos;
    t.apply({ type: 'requestSeat', playerId: 'guest', name: 'Guest', seat: 5 });
    t.apply({ type: 'approveSeat', byId: 'p0', playerId: 'guest' });
    expect(t.state.hosted).toBe(true);
    expect(t.state.phase).toBe('playing');
    expect(t.hand.handNo).toBe(handNo);
    expect(t.hand.round).toMatchObject({ kind: 'exchange', street: 'draw' });
    expect(t.toAct).toBe(toAct);
    expect(t.hand.deckPos).toBe(deckPos);
    expect(t.hand.inHand).not.toContain('guest');
    expect(t.seatOf('guest')).toBe(5);
  });
});
