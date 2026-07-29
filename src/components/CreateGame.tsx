'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export function CreateGame() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'quick' | 'friends'>('quick');
  // Numeric fields stay as raw strings while editing (so the field can be
  // emptied on mobile); they're parsed with defaults on submit.
  const [stack, setStack] = useState('20');
  const [smallBlind, setSmallBlind] = useState('1');
  const [bigBlind, setBigBlind] = useState('2');
  const [bots, setBots] = useState('0');
  const [topUps, setTopUps] = useState('2');
  const [topUpDecay, setTopUpDecay] = useState('50');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!name.trim()) {
      setError('Enter your name first');
      return;
    }
    setBusy(true);
    setError(null);
    const parse = (raw: string, fallback: number) => {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n > 0 ? n : fallback;
    };
    // Unlike the fields above, 0 is a meaningful choice here (disable / flat).
    const parse0 = (raw: string, fallback: number) => {
      const n = parseInt(raw, 10);
      return Number.isFinite(n) && n >= 0 ? n : fallback;
    };
    try {
      const res = await fetch('/api/games', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(
          mode === 'quick'
            ? { name, quickPlay: true }
            : {
                name,
                bots: parse(bots, 0),
                config: {
                  startingStack: parse(stack, 20),
                  smallBlind: parse(smallBlind, 1),
                  bigBlind: parse(bigBlind, 2),
                  topUps: parse0(topUps, 2),
                  topUpDecayPct: parse0(topUpDecay, 50),
                },
              }
        ),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message ?? 'Failed to create game');
      router.push(`/game/${data.gameId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
      setBusy(false);
    }
  };

  const field =
    'w-full rounded-lg border border-black/15 bg-transparent px-3 py-2 dark:border-white/20';

  return (
    <div className="flex flex-col gap-4">
      <input
        className={field}
        placeholder="Your name"
        value={name}
        maxLength={20}
        onChange={(e) => setName(e.target.value)}
      />

      <div className="grid grid-cols-2 gap-2">
        <button
          className={`rounded-lg border px-3 py-3 text-sm font-medium ${
            mode === 'quick' ? 'border-emerald-600 bg-emerald-600/10' : 'border-black/15 dark:border-white/20'
          }`}
          onClick={() => setMode('quick')}
        >
          🤖 Play now
          <div className="text-xs font-normal opacity-70">vs 5 computer players</div>
        </button>
        <button
          className={`rounded-lg border px-3 py-3 text-sm font-medium ${
            mode === 'friends' ? 'border-emerald-600 bg-emerald-600/10' : 'border-black/15 dark:border-white/20'
          }`}
          onClick={() => setMode('friends')}
        >
          👥 Host a game
          <div className="text-xs font-normal opacity-70">invite friends by link</div>
        </button>
      </div>

      {mode === 'friends' && (
        <div className="grid grid-cols-2 gap-3 text-sm">
          {(
            [
              { label: 'Starting coins', value: stack, set: setStack, placeholder: '20' },
              { label: 'Computer players', value: bots, set: setBots, placeholder: '0' },
              { label: 'Small blind', value: smallBlind, set: setSmallBlind, placeholder: '1' },
              { label: 'Big blind', value: bigBlind, set: setBigBlind, placeholder: '2' },
              { label: 'Top-ups per player', value: topUps, set: setTopUps, placeholder: '2' },
              { label: 'Top-up shrink %', value: topUpDecay, set: setTopUpDecay, placeholder: '50' },
            ] as const
          ).map((f) => (
            <label key={f.label} className="flex flex-col gap-1">
              {f.label}
              <input
                className={field}
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                placeholder={f.placeholder}
                value={f.value}
                onChange={(e) => f.set(e.target.value.replace(/\D/g, '').slice(0, 5))}
              />
            </label>
          ))}
        </div>
      )}

      {error && <p className="text-sm text-red-500">{error}</p>}

      <button
        className="rounded-lg bg-emerald-600 px-4 py-3 font-semibold text-white disabled:opacity-50"
        disabled={busy}
        onClick={submit}
      >
        {busy ? 'Setting up the table…' : mode === 'quick' ? 'Deal me in' : 'Create table'}
      </button>
    </div>
  );
}
