'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import type { GameApi } from '@/hooks/useGame';

interface DrawSelectValue {
  /** True when it's your five-card-draw discard turn. */
  active: boolean;
  selected: number[];
  max: number;
  toggle: (i: number) => void;
}

const DrawSelectContext = createContext<DrawSelectValue>({
  active: false,
  selected: [],
  max: 0,
  toggle: () => {},
});

export function useDrawSelect(): DrawSelectValue {
  return useContext(DrawSelectContext);
}

/** Shares discard-tap state between the table cards and the ActionBar buttons. */
export function DrawSelectProvider({ game, children }: { game: GameApi; children: ReactNode }) {
  const state = game.state!;
  const hand = state.hand;
  const me = state.yourId ? state.players[state.yourId] : null;
  const legal = hand?.legalActions ?? null;
  const spec = legal?.kind === 'exchange' ? legal.moves.find((m) => m.kind === 'discard') : undefined;
  const active =
    !!me && state.phase === 'playing' && hand?.toAct === me.id && spec?.kind === 'discard';
  const max = spec?.kind === 'discard' ? spec.max : 0;

  const turnKey = `${hand?.handNo}|${hand?.street}|${hand?.toAct}|${active}`;
  const [prevKey, setPrevKey] = useState(turnKey);
  const [selected, setSelected] = useState<number[]>([]);
  if (prevKey !== turnKey) {
    setPrevKey(turnKey);
    setSelected([]);
  }

  const toggle = useCallback(
    (i: number) => {
      setSelected((prev) =>
        prev.includes(i) ? prev.filter((x) => x !== i) : prev.length < max ? [...prev, i] : prev
      );
    },
    [max]
  );

  const value = useMemo(
    () => ({ active: !!active, selected, max, toggle }),
    [active, selected, max, toggle]
  );
  return <DrawSelectContext.Provider value={value}>{children}</DrawSelectContext.Provider>;
}
