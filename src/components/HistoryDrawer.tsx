'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';
import { describeEvent } from './history';

function lineClass(text: string): string {
  if (text.startsWith('—')) return 'font-semibold text-amber-300';
  if (
    text.includes(' wins $') ||
    text.includes(' had ') ||
    text.startsWith('Board:') ||
    text.startsWith('Pots:') ||
    text.includes('uncalled')
  ) {
    return 'text-emerald-200';
  }
  return '';
}

export function HistoryDrawer({ game }: { game: GameApi }) {
  const [open, setOpen] = useState(false);
  const state = game.state!;
  const names = (id: string) => state.players[id]?.name ?? '?';

  const lines = state.events.flatMap((e) =>
    describeEvent(e, names).map((text, i) => ({ key: `${e.seq}-${i}`, text }))
  );

  return (
    <>
      <button
        className="rounded-lg bg-white/10 px-2.5 py-1.5 text-sm text-white/80 active:scale-95"
        onClick={() => setOpen((o) => !o)}
        aria-label="hand history"
      >
        🕐
      </button>
      {open && (
        <div className="absolute right-2 top-12 z-40 flex max-h-[60dvh] w-80 max-w-[90vw] flex-col overflow-hidden rounded-xl border border-white/15 bg-zinc-950/95 shadow-2xl backdrop-blur sm:w-96">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-sm font-semibold text-white">
            Hand history
            <button className="text-white/60" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="flex flex-col-reverse overflow-y-auto px-3 py-2 text-xs leading-5 text-white/80">
            {[...lines].reverse().map((l) => (
              <div key={l.key} className={lineClass(l.text)}>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
