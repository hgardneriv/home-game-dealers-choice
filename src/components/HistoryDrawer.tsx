'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';
import type { GameEvent } from '@/engine/types';

function describeEvent(event: GameEvent, names: (id: string) => string): string | null {
  const d = event.data as Record<string, unknown>;
  switch (event.type) {
    case 'hand-started':
      return `— Hand #${d.handNo} —`;
    case 'blind-posted':
      return `${names(String(d.playerId))} posts ${d.kind} blind $${d.amount}`;
    case 'action': {
      const move = String(d.move);
      const auto = d.auto ? ' (auto)' : '';
      if (move === 'fold' || move === 'check') return `${names(String(d.playerId))} ${move}s${auto}`;
      if (move === 'call') return `${names(String(d.playerId))} calls $${d.amount}${auto}`;
      return `${names(String(d.playerId))} ${move}s to $${d.amount}`;
    }
    case 'street-dealt':
      return `${String(d.street)}: ${(d.cards as string[]).join(' ')}`;
    case 'hand-result': {
      const pots = d.pots as { amount: number; winners: string[] }[];
      return pots
        .map((p) => `${p.winners.map(names).join(' & ')} wins $${p.amount}`)
        .join(', ');
    }
    case 'player-seated':
      return `${String(d.name)} sits down`;
    case 'player-removed':
      return d.status === 'kicked'
        ? `${names(String(d.playerId))} was removed by the host`
        : `${names(String(d.playerId))} left the game`;
    case 'player-busted':
      return `${names(String(d.playerId))} is busted`;
    case 'player-away':
      return `${names(String(d.playerId))} is away`;
    case 'player-back':
      return `${names(String(d.playerId))} is back`;
    case 'time-bank':
      return `${names(String(d.playerId))} uses time bank`;
    case 'game-ended':
      return d.winnerId ? `🏆 ${names(String(d.winnerId))} wins the game!` : 'Game over';
    default:
      return null;
  }
}

export function HistoryDrawer({ game }: { game: GameApi }) {
  const [open, setOpen] = useState(false);
  const state = game.state!;
  const names = (id: string) => state.players[id]?.name ?? '?';

  const lines = state.events
    .map((e) => ({ seq: e.seq, text: describeEvent(e, names) }))
    .filter((l): l is { seq: number; text: string } => l.text !== null);

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
        <div className="absolute right-2 top-12 z-40 flex max-h-[60dvh] w-72 max-w-[90vw] flex-col overflow-hidden rounded-xl border border-white/15 bg-zinc-950/95 shadow-2xl backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-sm font-semibold text-white">
            Hand history
            <button className="text-white/60" onClick={() => setOpen(false)}>
              ✕
            </button>
          </div>
          <div className="flex flex-col-reverse overflow-y-auto px-3 py-2 text-xs leading-5 text-white/80">
            {[...lines].reverse().map((l) => (
              <div key={l.seq} className={l.text.startsWith('—') ? 'font-semibold text-amber-300' : ''}>
                {l.text}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
