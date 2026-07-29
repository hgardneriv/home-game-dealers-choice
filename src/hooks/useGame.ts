'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientGameState } from '@/server/redact';
import type { PlayerMove, VariantId } from '@/engine/types';

export interface GameApi {
  state: ClientGameState | null;
  error: string | null;
  /** Server-clock-corrected "now" for countdowns. */
  serverNow: () => number;
  join: (name: string, seat: number) => Promise<string | null>;
  act: (move: PlayerMove | 'imBack' | 'leave' | 'topUp', amount?: number, expectedCall?: number) => Promise<string | null>;
  /** Dealer's call: pick the next game while the table is choosing. */
  chooseGame: (variant: VariantId) => Promise<string | null>;
  /** Exchange-round move (five-card draw): discard the given card indexes. */
  draw: (cardIndexes: number[]) => Promise<string | null>;
  hostOp: (op: string, playerId?: string) => Promise<string | null>;
  seatOp: (op: 'approve' | 'deny', playerId: string) => Promise<string | null>;
  refresh: () => void;
}

/**
 * Live game state via SSE (EventSource) with a slow polling safety net and
 * a resync on tab visibility. Versions are monotonic — stale data is dropped.
 */
export function useGame(gameId: string): GameApi {
  const [state, setState] = useState<ClientGameState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const versionRef = useRef(0);
  const skewRef = useRef(0);
  const identityRef = useRef<string | null>(null);
  const reconnectRef = useRef<() => void>(() => {});
  const lastReconnectRef = useRef(0);

  const applyState = useCallback((next: ClientGameState) => {
    skewRef.current = next.now - Date.now();
    // Never let an unauthenticated frame downgrade an identified session.
    // (An SSE stream opened before the player joined is authenticated as
    // nobody — its pushes would bounce them to the join screen.)
    if (!next.yourId && identityRef.current) {
      if (Date.now() - lastReconnectRef.current > 5000) {
        lastReconnectRef.current = Date.now();
        reconnectRef.current();
      }
      return;
    }
    if (next.version >= versionRef.current) {
      versionRef.current = next.version;
      if (next.yourId) identityRef.current = next.yourId;
      setState(next);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/games/${gameId}/state`, { cache: 'no-store' });
      if (!res.ok) {
        if (res.status === 404) setError('Game not found — it may have expired.');
        return;
      }
      const data = await res.json();
      if (data.state) applyState(data.state);
    } catch {
      // transient network error — next poll retries
    }
  }, [gameId, applyState]);

  useEffect(() => {
    let source: EventSource | null = null;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      source?.close();
      source = new EventSource(`/api/games/${gameId}/stream`);
      source.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          if (data.state) applyState(data.state);
        } catch {
          // malformed frame — safety-net poll will resync
        }
      };
      // EventSource auto-reconnects on transient errors; nothing to do here.
    };

    reconnectRef.current = connect;
    const initial = setTimeout(connect, 0);
    // Safety net: a slow poll catches anything a dropped stream missed.
    const safetyPoll = setInterval(refresh, 10_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        refresh(); // instant state on return from background
        connect(); // and a fresh stream (mobile browsers kill idle ones)
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(safetyPoll);
      source?.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [gameId, refresh, applyState]);

  const post = useCallback(
    async (path: string, body: unknown): Promise<string | null> => {
      try {
        const res = await fetch(`/api/games/${gameId}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json().catch(() => ({}));
        if (data.state) applyState(data.state);
        if (!res.ok) {
          if (res.status === 409) refresh(); // stale — resync silently
          return data.error?.message ?? `Request failed (${res.status})`;
        }
        return null;
      } catch {
        return 'Network error';
      }
    },
    [gameId, applyState, refresh]
  );

  return {
    state,
    error,
    serverNow: () => Date.now() + skewRef.current,
    join: async (name, seat) => {
      const err = await post('join', { name, seat });
      // The stream predates our cookie — reconnect so it knows who we are.
      if (!err) reconnectRef.current();
      return err;
    },
    act: (move, amount, expectedCall) => post('action', { move, amount, expectedCall }),
    chooseGame: (variant) => post('action', { move: 'chooseGame', variant }),
    draw: (cardIndexes) => post('action', { move: 'variantMove', cardIndexes }),
    hostOp: (op, playerId) => post('host', { op, playerId }),
    seatOp: (op, playerId) => post('seats', { op, playerId }),
    refresh,
  };
}
