import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LAST_GAME_KEY,
  clearLastGameId,
  readLastGameId,
  rememberedTableAction,
  writeLastGameId,
} from './lastGame';

function mockStorage() {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
  };
  vi.stubGlobal('localStorage', localStorage);
  vi.stubGlobal('window', {
    localStorage,
    dispatchEvent: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

const seated = {
  phase: 'playing' as const,
  resultsShown: false,
  hand: null as { result: unknown } | null,
  yourId: 'h',
  players: { h: { status: 'seated', seat: 0 as number | null } },
  seatRequests: [] as { playerId: string }[],
};

const standings = {
  ...seated,
  phase: 'ended' as const,
  resultsShown: true,
  hand: { result: { pots: [] } },
  players: { h: { status: 'busted', seat: 0 as number | null } },
};

describe('lastGame storage', () => {
  beforeEach(() => {
    mockStorage();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('starts empty', () => {
    expect(readLastGameId()).toBeNull();
    expect(LAST_GAME_KEY).toBe('hg:lastGameId');
  });

  it('remembers and clears a table id', () => {
    writeLastGameId('abc123');
    expect(readLastGameId()).toBe('abc123');
    clearLastGameId();
    expect(readLastGameId()).toBeNull();
  });

  it('ignores a storage that throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    });
    expect(readLastGameId()).toBeNull();
    expect(() => writeLastGameId('abc')).not.toThrow();
    expect(() => clearLastGameId()).not.toThrow();
  });
});

describe('rememberedTableAction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('writes while a game is in progress, including a bust and a pending seat', () => {
    expect(rememberedTableAction('g1', { error: false, state: seated })).toEqual({
      action: 'write',
      gameId: 'g1',
    });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: {
          phase: 'lobby',
          resultsShown: false,
          hand: null,
          yourId: 'g',
          players: { g: { status: 'seated', seat: null } },
          seatRequests: [{ playerId: 'g' }],
        },
      })
    ).toEqual({ action: 'write', gameId: 'g1' });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: {
          ...seated,
          players: { h: { status: 'busted', seat: 0 } },
        },
      })
    ).toEqual({ action: 'write', gameId: 'g1' });
    // Last hand still on the felt — not the standings screen.
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: {
          ...seated,
          phase: 'ended',
          resultsShown: false,
          hand: { result: { pots: [] } },
        },
      })
    ).toEqual({ action: 'write', gameId: 'g1' });
  });

  it('does not offer a return link once the standings are up', () => {
    expect(rememberedTableAction('g1', { error: false, state: standings })).toEqual({
      action: 'clear',
    });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: { ...seated, phase: 'ended', hand: null },
      })
    ).toEqual({ action: 'clear' });
  });

  it('Play again that goes home clears the saved id', () => {
    mockStorage();
    writeLastGameId('g1');
    const memory = rememberedTableAction('g1', { error: false, state: standings });
    expect(memory).toEqual({ action: 'clear' });
    if (memory.action === 'clear') clearLastGameId();
    expect(readLastGameId()).toBeNull();
  });

  it('clears a missing table, a leave, and a kick', () => {
    expect(rememberedTableAction('g1', { error: true, state: null })).toEqual({ action: 'clear' });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: { ...seated, players: { h: { status: 'left', seat: null } } },
      })
    ).toEqual({ action: 'clear' });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: { ...seated, players: { h: { status: 'kicked', seat: null } } },
      })
    ).toEqual({ action: 'clear' });
  });

  it('does not clobber the saved id for a spectator or while the table is still loading', () => {
    expect(rememberedTableAction('g1', { error: false, state: null })).toEqual({ action: 'keep' });
    expect(
      rememberedTableAction('other', {
        error: false,
        state: { ...seated, yourId: null },
      })
    ).toEqual({ action: 'keep' });
    expect(
      rememberedTableAction('other', {
        error: false,
        state: { ...standings, yourId: null },
      })
    ).toEqual({ action: 'keep' });
  });
});
