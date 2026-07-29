'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';
import { useToast } from './Toast';
import { LeaveButton } from './LeaveButton';

export function ActionBar({ game }: { game: GameApi }) {
  const toast = useToast();
  const state = game.state!;
  const hand = state.hand;
  const me = state.yourId ? state.players[state.yourId] : null;
  const legal = hand?.legalActions ?? null;
  const myTurn = !!me && !!hand && hand.toAct === me.id && !!legal;

  const [raiseTo, setRaiseTo] = useState<number | null>(null);
  const [showSizing, setShowSizing] = useState(false);
  const [busy, setBusy] = useState(false);

  // Reset the sizing UI when the turn context changes (adjust-during-render).
  const turnKey = `${hand?.handNo}|${hand?.street}|${hand?.toAct}|${hand?.currentBet}`;
  const [prevTurnKey, setPrevTurnKey] = useState(turnKey);
  if (prevTurnKey !== turnKey) {
    setPrevTurnKey(turnKey);
    setShowSizing(false);
    setRaiseTo(null);
    setBusy(false);
  }

  const leave = me && !me.isHost ? <LeaveButton game={game} /> : null;

  // Away banner beats everything.
  if (me && me.status === 'away') {
    return (
      <div className="sticky bottom-0 flex items-center gap-3 border-t border-white/10 bg-zinc-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {leave}
        <span className="flex-1 text-center text-sm text-white">💤 You&apos;re sitting out</span>
        <button
          className="rounded-xl bg-emerald-600 px-4 py-3 font-semibold text-white"
          onClick={() => game.act('imBack')}
        >
          I&apos;m back
        </button>
      </div>
    );
  }

  if (!myTurn || !legal || !hand) {
    return (
      <div className="sticky bottom-0 flex items-center gap-3 border-t border-white/10 bg-zinc-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        {leave}
        <span className="flex-1 text-center text-sm text-white/60">
          {state.phase === 'playing'
            ? hand?.toAct
              ? `Waiting for ${state.players[hand.toAct]?.name}…`
              : '…'
            : state.phase === 'hand-over'
              ? 'Next hand starting…'
              : state.phase === 'lobby'
                ? 'Waiting to start'
                : state.phase === 'paused'
                  ? 'Game paused'
                  : 'Game over'}
        </span>
        {leave && <span className="w-24" aria-hidden />}
      </div>
    );
  }

  const potTotal = hand.potTotal;
  const canOpen = legal.canBet;
  const aggLabel = canOpen ? 'Bet' : 'Raise';
  const clampTo = (v: number) =>
    Math.max(legal.minRaiseTo, Math.min(legal.maxRaiseTo, Math.round(v)));

  const presets: { label: string; value: number }[] = [
    { label: 'Min', value: legal.minRaiseTo },
    { label: '½ Pot', value: clampTo(hand.currentBet + Math.ceil(potTotal / 2)) },
    { label: 'Pot', value: clampTo(hand.currentBet + potTotal) },
    { label: 'All-in', value: legal.maxRaiseTo },
  ];

  const submit = async (move: 'fold' | 'check' | 'call' | 'bet' | 'raise', amount?: number) => {
    if (busy) return;
    setBusy(true);
    const error = await game.act(move, amount, move === 'call' ? legal.callAmount : undefined);
    if (error) toast(error);
    setBusy(false);
    setShowSizing(false);
  };

  const btn =
    'flex-1 rounded-xl px-3 py-3 font-semibold text-white disabled:opacity-40 active:scale-95 transition';

  return (
    <div className="sticky bottom-0 flex flex-col gap-2 border-t border-white/10 bg-zinc-900 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      {showSizing && (legal.canBet || legal.canRaise) && (
        <div className="flex flex-col gap-2">
          <div className="flex gap-2">
            {presets.map((p) => (
              <button
                key={p.label}
                className={`flex-1 rounded-lg px-2 py-2 text-sm font-semibold ${
                  raiseTo === p.value ? 'bg-amber-500 text-black' : 'bg-zinc-700 text-white'
                }`}
                onClick={() => setRaiseTo(p.value)}
              >
                {p.label}
                <div className="text-xs opacity-75">${p.value}</div>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              className="flex-1 accent-amber-500"
              min={legal.minRaiseTo}
              max={legal.maxRaiseTo}
              value={raiseTo ?? legal.minRaiseTo}
              onChange={(e) => setRaiseTo(Number(e.target.value))}
            />
            <span className="w-14 text-right font-bold text-amber-400">
              ${raiseTo ?? legal.minRaiseTo}
            </span>
          </div>
          <button
            className={`${btn} bg-amber-600`}
            disabled={busy}
            onClick={() => submit(canOpen ? 'bet' : 'raise', raiseTo ?? legal.minRaiseTo)}
          >
            {aggLabel} to ${raiseTo ?? legal.minRaiseTo}
          </button>
        </div>
      )}

      <div className="flex gap-2">
        {leave}
        <button className={`${btn} bg-red-700`} disabled={busy} onClick={() => submit('fold')}>
          Fold
        </button>
        {legal.canCheck ? (
          <button className={`${btn} bg-zinc-600`} disabled={busy} onClick={() => submit('check')}>
            Check
          </button>
        ) : (
          <button className={`${btn} bg-emerald-700`} disabled={busy} onClick={() => submit('call')}>
            Call ${legal.callAmount}
          </button>
        )}
        {(legal.canBet || legal.canRaise) && (
          <button
            className={`${btn} ${showSizing ? 'bg-zinc-700' : 'bg-amber-600'}`}
            disabled={busy}
            onClick={() => setShowSizing((s) => !s)}
          >
            {showSizing ? 'Hide' : aggLabel}
          </button>
        )}
      </div>
    </div>
  );
}
