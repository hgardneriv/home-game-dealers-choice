import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Table, legalFor, REBUY_CONFIG } from './test-utils';
import { _registerVariantForTest } from './variants/registry';
import {
  boardStrength,
  sevenStud,
  studStrength,
  studViewStrength,
} from './variants/seven-stud';
import { redactForPlayer } from '@/server/redact';
import type { BettingLegal, Card } from './types';
import type { BotView } from './bot';

/**
 * Seven-card stud scenarios. zeroRand geometry: first-hand button = seat 0
 * (p0), hand order [p1, p2, ..., p0]. Unlike positional games, the opener of
 * every betting round is the best SHOWING board, so tests either read toAct
 * from the state or rig the boards to pin it.
 */

const STUD = { enabledVariants: ['seven-stud'] as ['seven-stud'] };

let cleanup: () => void;
beforeEach(() => {
  cleanup = _registerVariantForTest(sevenStud);
});
afterEach(() => {
  cleanup();
});

function studTable(players = 3) {
  const t = new Table(players, { config: STUD });
  t.start();
  return t;
}

/** Check/call every decision until the current street closes. */
function checkStreet(t: Table): void {
  const street = t.hand.round.street;
  let guard = 0;
  while (t.state.phase === 'playing' && t.hand.round.street === street) {
    if (guard++ > 30) throw new Error('street did not advance');
    const id = t.toAct!;
    const legal = legalFor(t.state, id);
    t.act(id, legal.canCheck ? 'check' : 'call');
  }
}

/** Plant a player's cards with explicit down/up split (rig() only does down). */
function setCards(t: Table, id: string, down: Card[], up: Card[]): void {
  t.hand.playerCards[id] = {
    cards: [...down, ...up],
    faceUp: [...down.map(() => false), ...up.map(() => true)],
  };
}

function studEvents(t: Table) {
  return t.state.events
    .filter((e) => e.type === 'stud-street')
    .map((e) => e.data as { street: string; upCards: Record<string, Card> });
}

describe('dealing', () => {
  it('deals two down and one up to every player and opens third street', () => {
    const t = studTable(3);
    expect(t.hand.variant).toBe('seven-stud');
    expect(t.hand.round).toMatchObject({ kind: 'betting', street: 'third' });
    for (const id of ['p0', 'p1', 'p2']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(3);
      expect(t.hand.playerCards[id].faceUp).toEqual([false, false, true]);
    }
    expect(t.hand.board).toEqual([]);
    expect(t.hand.deckPos).toBe(9);
    expect(['p0', 'p1', 'p2']).toContain(t.toAct);
  });

  it('streets deal one card each — up, up, up, then seventh down — then showdown', () => {
    const t = studTable(3);
    const shapes: [string, boolean[]][] = [
      ['fourth', [false, false, true, true]],
      ['fifth', [false, false, true, true, true]],
      ['sixth', [false, false, true, true, true, true]],
      ['seventh', [false, false, true, true, true, true, false]],
    ];
    for (const [street, faceUp] of shapes) {
      checkStreet(t);
      expect(t.hand.round).toMatchObject({ kind: 'betting', street });
      for (const id of ['p0', 'p1', 'p2']) {
        expect(t.hand.playerCards[id].faceUp).toEqual(faceUp);
      }
    }
    checkStreet(t); // seventh-street betting closes into showdown
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.hand.deckPos).toBe(21); // 9 dealt + 3 players × 4 streets
    expect(t.totalChips()).toBe(60);
  });

  it('folded players stop receiving cards', () => {
    const t = studTable(3);
    const folder = t.toAct!;
    t.act(folder, 'fold');
    checkStreet(t);
    expect(t.hand.round.street).toBe('fourth');
    expect(t.hand.playerCards[folder].cards).toHaveLength(3);
    for (const id of ['p0', 'p1', 'p2'].filter((p) => p !== folder)) {
      expect(t.hand.playerCards[id].cards).toHaveLength(4);
    }
    expect(t.hand.deckPos).toBe(11); // 9 + only the two live players
  });

  it('stud-street events publish exactly the new up-cards; seventh publishes none', () => {
    const t = studTable(3);
    const third = studEvents(t).at(-1)!;
    expect(third.street).toBe('third');
    for (const id of ['p0', 'p1', 'p2']) {
      expect(third.upCards[id]).toBe(t.hand.playerCards[id].cards[2]);
    }
    checkStreet(t);
    const fourth = studEvents(t).at(-1)!;
    expect(fourth.street).toBe('fourth');
    for (const id of ['p0', 'p1', 'p2']) {
      expect(fourth.upCards[id]).toBe(t.hand.playerCards[id].cards[3]);
    }
    checkStreet(t);
    checkStreet(t);
    checkStreet(t);
    const seventh = studEvents(t).at(-1)!;
    expect(seventh).toEqual({ street: 'seventh', upCards: {} });
  });
});

describe('betting', () => {
  it('standard bet/raise/call flow closes a stud street', () => {
    const t = studTable(3);
    const a = t.toAct!;
    t.act(a, 'bet', 2);
    const b = t.toAct!;
    t.act(b, 'raise', 4);
    const c = t.toAct!;
    t.act(c, 'call');
    expect(t.toAct).toBe(a); // the opener still owes the raise
    t.act(a, 'call');
    expect(t.hand.round.street).toBe('fourth');
    expect(t.totalChips()).toBe(60);
  });
});

describe('redaction', () => {
  it('opponents and spectators see exactly the up-cards, never the down cards', () => {
    const t = studTable(3);
    checkStreet(t); // fourth street: two up-cards each
    const p1 = t.hand.playerCards['p1'];
    const view = redactForPlayer(t.state, 'p2');
    expect(view.hand!.publicCards['p1']).toEqual([p1.cards[2], p1.cards[3]]);
    expect(view.hand!.myCards).toEqual(t.hand.playerCards['p2'].cards);
    for (const viewer of ['p2', 'p0', null]) {
      const json = JSON.stringify(redactForPlayer(t.state, viewer));
      expect(json).not.toContain(p1.cards[0]);
      expect(json).not.toContain(p1.cards[1]);
    }
  });
});

describe('first to act: best showing board', () => {
  it('board strength orders quads > trips > two pair > pair > high cards, ranks break ties', () => {
    expect(boardStrength(['5s', '5h', '5d', '5c'])).toBeGreaterThan(
      boardStrength(['As', 'Ah', 'Ad', 'Kc'])
    );
    expect(boardStrength(['As', 'Ah', 'Ad', 'Kc'])).toBeGreaterThan(
      boardStrength(['As', 'Ah', 'Kd', 'Kc'])
    );
    expect(boardStrength(['As', 'Ah', 'Kd', 'Kc'])).toBeGreaterThan(
      boardStrength(['As', 'Ah', 'Kd', 'Qc'])
    );
    expect(boardStrength(['2s', '2h', '3d', '4c'])).toBeGreaterThan(
      boardStrength(['As', 'Kh', 'Qd', 'Jc'])
    );
    expect(boardStrength(['Ks', 'Kh'])).toBeGreaterThan(boardStrength(['Qs', 'Qh']));
    expect(boardStrength(['As', 'Kh'])).toBeGreaterThan(boardStrength(['As', 'Qh']));
  });

  it('a pair showing opens over an ace-high board', () => {
    const t = studTable(3);
    setCards(t, 'p1', ['2c', '7d'], ['Ah', 'Kd']);
    setCards(t, 'p2', ['4c', '8d'], ['3s', '3d']);
    setCards(t, 'p0', ['5c', '9d'], ['Qh', 'Jc']);
    expect(sevenStud.firstToAct!(t.state, t.hand)).toBe('p2');
  });

  it('tied boards break clockwise from the button (first in hand order)', () => {
    const t = studTable(3);
    setCards(t, 'p1', ['2c', '7d'], ['5d']);
    setCards(t, 'p2', ['4c', '8d'], ['Ks']);
    setCards(t, 'p0', ['6c', '9d'], ['Kh']);
    // inHand order [p1, p2, p0]: p2 wins the K-vs-K tie.
    expect(sevenStud.firstToAct!(t.state, t.hand)).toBe('p2');
  });

  it('an all-in best board falls to the next-best who can act; null when nobody can', () => {
    const t = studTable(3);
    setCards(t, 'p1', ['2c', '7d'], ['Ah', 'Kd']);
    setCards(t, 'p2', ['4c', '8d'], ['3s', '3d']);
    setCards(t, 'p0', ['5c', '9d'], ['Qh', 'Jc']);
    t.hand.allIn = ['p2'];
    expect(sevenStud.firstToAct!(t.state, t.hand)).toBe('p1');
    t.hand.allIn = ['p1', 'p2', 'p0'];
    expect(sevenStud.firstToAct!(t.state, t.hand)).toBeNull();
  });

  it('the engine hands the fourth-street opener to a freshly paired board', () => {
    const t = studTable(3);
    setCards(t, 'p1', ['2c', '7d'], ['Ah']);
    setCards(t, 'p2', ['4c', '8d'], ['3s']);
    setCards(t, 'p0', ['5c', '9d'], ['Kh']);
    // Fourth street deals to [p1, p2, p0] in order: p2 pairs the door card.
    const dp = t.hand.deckPos;
    t.hand.deck[dp] = '6c';
    t.hand.deck[dp + 1] = '3d';
    t.hand.deck[dp + 2] = 'Th';
    checkStreet(t);
    expect(t.hand.round.street).toBe('fourth');
    expect(t.toAct).toBe('p2');
  });
});

describe('all-in runout', () => {
  it('skipped betting streets still deal — both hands reach seven cards', () => {
    const t = new Table(2, { config: { ...STUD, ante: 1, minBet: 2, ...REBUY_CONFIG }, stacks: [20, 5] });
    t.start();
    const first = t.toAct!;
    t.act(first, 'bet', legalFor(t.state, first).maxRaiseTo);
    const second = t.toAct!;
    t.act(second, 'call');
    expect(t.state.phase).toBe('hand-over'); // runout ran without further turns
    for (const id of ['p0', 'p1']) {
      expect(t.hand.playerCards[id].cards).toHaveLength(7);
      expect(t.hand.playerCards[id].faceUp).toEqual([
        false, false, true, true, true, true, false,
      ]);
    }
    expect(t.hand.result).not.toBeNull();
    expect(t.totalChips()).toBe(25);
  });
});

describe('showdown', () => {
  it('scores the best five of seven (flush beats two pair)', () => {
    const t = new Table(2, { config: STUD });
    t.start();
    setCards(t, 'p1', ['2s', '5s'], ['9s']);
    setCards(t, 'p0', ['Ad', 'Ac'], ['Kd']);
    // Streets deal to [p1, p0] in order.
    const plants = ['Js', 'Kh', 'Qs', '2d', '3h', '4h', '6d', '7c'];
    plants.forEach((c, i) => {
      t.hand.deck[t.hand.deckPos + i] = c;
    });
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const result = t.hand.result!;
    expect(result.pots[0].winners).toEqual(['p1']);
    expect(result.descriptions['p1']).toBe('Flush, Queen High');
    expect(t.stack('p1')).toBe(21);
    expect(t.stack('p0')).toBe(19);
    expect(t.totalChips()).toBe(40);
  });

  it('an ante-short all-in player wins only the main pot (side pots)', () => {
    const t = new Table(3, { config: { ...STUD, ante: 2 }, stacks: [20, 20, 1] });
    t.start();
    expect(t.hand.allIn).toEqual(['p2']); // short ante: 1 of the 2
    setCards(t, 'p1', ['Ks', 'Kh'], ['2c']);
    setCards(t, 'p2', ['As', 'Ah'], ['Ad']);
    setCards(t, 'p0', ['Qs', 'Qh'], ['3d']);
    // Streets deal to [p1, p2, p0]: p2 makes quads, p1 trips K, p0 trips Q.
    const plants = ['Kc', 'Ac', 'Qc', '5s', '4c', '6s', '7h', '8c', '9h', 'Tc', 'Jc', '5d'];
    plants.forEach((c, i) => {
      t.hand.deck[t.hand.deckPos + i] = c;
    });
    const bettor = t.toAct!;
    t.act(bettor, 'bet', 4);
    const caller = t.toAct!;
    t.act(caller, 'call');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    const pots = t.hand.result!.pots;
    expect(pots[0]).toMatchObject({ amount: 3, winners: ['p2'] }); // main: 1 × 3
    expect(pots[1]).toMatchObject({ amount: 10, winners: ['p1'] }); // side: p1 vs p0
    expect(t.stack('p2')).toBe(3);
    expect(t.stack('p1')).toBe(24);
    expect(t.stack('p0')).toBe(14);
    expect(t.totalChips()).toBe(41);
  });

  it('chips are conserved across consecutive hands', () => {
    const t = studTable(3);
    for (let handNo = 1; handNo <= 3; handNo++) {
      expect(t.hand.handNo).toBe(handNo);
      t.checkDown();
      expect(t.state.phase).toBe('hand-over');
      expect(t.totalChips()).toBe(60);
      if (handNo < 3) t.nextHand();
    }
  });
});

describe('dealer choice integration', () => {
  it('a dealer can call seven-card stud and the whole hand settles', () => {
    const t = new Table(3, {
      config: { enabledVariants: ['holdem', 'seven-stud'] as ('holdem' | 'seven-stud')[] },
    });
    t.start();
    expect(t.state.phase).toBe('choosing');
    t.apply({ type: 'chooseGame', playerId: 'p0', variant: 'seven-stud' });
    expect(t.hand.variant).toBe('seven-stud');
    t.checkDown();
    expect(t.state.phase).toBe('hand-over');
    expect(t.hand.result).not.toBeNull();
    expect(t.totalChips()).toBe(60);
  });
});

describe('bot', () => {
  it('rates made five-to-seven-card hands by category', () => {
    expect(studStrength(['2s', '5s', '9s', 'Js', 'Qs', '3h', '6d'])).toBeGreaterThan(0.9);
    const twoPair = studStrength(['Ad', 'Ac', 'Kd', 'Kh', '2d', '4h', '7c']);
    expect(twoPair).toBeGreaterThan(0.6);
    expect(twoPair).toBeLessThan(0.8);
    expect(studStrength(['2s', '5h', '9d', 'Jc', 'Qd', '3h', '7c'])).toBeLessThan(0.25);
  });

  it('picks the best five from six cards', () => {
    expect(studStrength(['2s', '5s', '9s', 'Js', 'Qs', '3h'])).toBeGreaterThanOrEqual(0.91);
  });

  it('third-street heuristic: trips > big pair > three-flush > junk', () => {
    const trips = studStrength(['9s', '9h', '9d']);
    const pairAces = studStrength(['As', 'Ah', '4d']);
    const pairDeuces = studStrength(['2s', '2h', '7d']);
    const threeFlush = studStrength(['Ks', '7s', '2s']);
    const junk = studStrength(['Kd', '7h', '2c']);
    expect(trips).toBeGreaterThan(pairAces);
    expect(pairAces).toBeGreaterThan(pairDeuces);
    expect(pairDeuces).toBeGreaterThan(threeFlush);
    expect(threeFlush).toBeGreaterThan(junk);
    expect(junk).toBeLessThan(0.3);
  });

  it('rewards straight potential', () => {
    expect(studStrength(['9s', 'Th', 'Jc'])).toBeGreaterThan(studStrength(['3s', '9h', 'Jc']));
  });

  it('discounts strength when an opponent board alone beats the whole hand', () => {
    const hole: Card[] = ['As', 'Ah', '4d', '7c']; // pair of aces
    const clean = studViewStrength({ hole, publicCards: {} });
    const scared = studViewStrength({ hole, publicCards: { villain: ['9s', '9h', '9d'] } });
    expect(scared).toBeLessThan(clean);
    expect(clean - scared).toBeCloseTo(0.15, 5);
  });

  it('bets strong hands and folds junk facing a big bet', () => {
    const mkView = (hole: Card[], legal: BettingLegal): BotView => ({
      hole,
      board: [],
      publicCards: {},
      potTotal: 10,
      stack: 20,
      committed: 0,
      legal,
      activeCount: 3,
      personality: { tightness: 0.5, aggression: 0.5, bluffFreq: 0 },
      minBet: 2,
    });
    const rand = (k: number) => (max: number) => k % max;

    const openable: BettingLegal = {
      kind: 'betting',
      canFold: true,
      canCheck: true,
      callAmount: 0,
      canBet: true,
      canRaise: false,
      minRaiseTo: 2,
      maxRaiseTo: 20,
    };
    const strong = sevenStud.bot.decideBet(
      mkView(['9s', '9h', '9d', '9c', '2h'], openable),
      rand(10)
    );
    expect(strong.move).toBe('bet');
    expect(strong.amount).toBeGreaterThanOrEqual(2);
    expect(strong.amount).toBeLessThanOrEqual(20);

    const facingBet: BettingLegal = {
      kind: 'betting',
      canFold: true,
      canCheck: false,
      callAmount: 8,
      canBet: false,
      canRaise: true,
      minRaiseTo: 16,
      maxRaiseTo: 20,
    };
    const weak = sevenStud.bot.decideBet(mkView(['2s', '7h', 'Jd'], facingBet), rand(10));
    expect(weak.move).toBe('fold');
  });
});
