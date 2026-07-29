'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';

export function JoinScreen({ game }: { game: GameApi }) {
  const { state } = game;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openSeats = state
    ? state.seats.map((id, i) => ({ id, i })).filter((s) => s.id === null)
    : [];
  const hostName = state
    ? Object.values(state.players).find((p) => p.isHost)?.name
    : null;

  const join = async () => {
    if (!name.trim()) {
      setError('Enter your name');
      return;
    }
    setBusy(true);
    const err = await game.join(name.trim(), openSeats[0]?.i ?? 0);
    if (err) {
      setError(err);
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-5 p-6">
      <div className="text-center">
        <h1 className="text-2xl font-bold">🃏 You&apos;re invited!</h1>
        <p className="mt-2 text-sm opacity-70">
          {hostName ? `${hostName} is hosting poker night.` : 'Take a seat at the table.'}
        </p>
      </div>
      <input
        className="w-full rounded-lg border border-black/15 bg-transparent px-3 py-3 dark:border-white/20"
        placeholder="Your name"
        maxLength={20}
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && join()}
      />
      {error && <p className="text-sm text-red-500">{error}</p>}
      <button
        className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-50"
        disabled={busy}
        onClick={join}
      >
        {busy ? 'Asking for a seat…' : 'Take a seat'}
      </button>
      <p className="text-center text-xs opacity-60">
        The host approves who sits down. Your buy-in:{' '}
        {state ? `$${state.config.startingStack}` : '…'} in $1 coins.
      </p>
    </main>
  );
}
