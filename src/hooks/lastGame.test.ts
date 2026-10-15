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
  yourId: 'h',
  players: { h: { status: 'seated', seat: 0 } },
  seatRequests: [] as { playerId: string }[],
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
  it('writes while you are seated, waiting, or looking at an ended night', () => {
    expect(rememberedTableAction('g1', { error: false, state: seated })).toEqual({
      action: 'write',
      gameId: 'g1',
    });
    expect(
      rememberedTableAction('g1', {
        error: false,
        state: {
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
        state: { yourId: null, players: { h: { status: 'seated', seat: 0 } }, seatRequests: [] },
      })
    ).toEqual({ action: 'keep' });
  });
});
