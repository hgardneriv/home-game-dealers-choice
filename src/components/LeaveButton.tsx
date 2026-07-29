'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';

/**
 * Guests can duck out any time (boss incoming, spouse upset…). Two-tap
 * confirm so it can't fire from a stray tap next to Fold.
 */
export function LeaveButton({ game }: { game: GameApi }) {
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <button
        className="rounded-xl border border-white/15 bg-zinc-800 px-4 py-3 font-semibold text-white/90 transition active:scale-95"
        onClick={() => setConfirming(true)}
      >
        🚪 Leave
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <button
        className="rounded-xl bg-red-700 px-3 py-3 font-semibold text-white active:scale-95"
        onClick={() => game.act('leave')}
      >
        Really leave?
      </button>
      <button
        className="rounded-xl bg-zinc-700 px-3 py-3 text-white active:scale-95"
        onClick={() => setConfirming(false)}
      >
        ✕
      </button>
    </span>
  );
}
