'use client';

import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { useGame } from '@/hooks/useGame';
import { JoinScreen } from './JoinScreen';
import { Table } from './Table';
import { ActionBar } from './ActionBar';
import { HostPanel } from './HostPanel';
import { InviteButton } from './InviteButton';
import { HistoryDrawer } from './HistoryDrawer';
import { ToastProvider, useToast } from './Toast';
import { GameOverScreen } from './GameOverScreen';
import type { GameApi } from '@/hooks/useGame';

/** Announces table events (players leaving/being kicked) to everyone else. */
function EventNotices({ game }: { game: GameApi }) {
  const toast = useToast();
  const lastSeq = useRef<number | null>(null);
  const state = game.state;
  useEffect(() => {
    if (!state) return;
    const maxSeq = state.events.reduce((a, e) => Math.max(a, e.seq), 0);
    if (lastSeq.current === null) {
      lastSeq.current = maxSeq; // don't replay history on page load
      return;
    }
    for (const event of state.events) {
      if (event.seq <= lastSeq.current || event.type !== 'player-removed') continue;
      const d = event.data as { playerId: string; status: string };
      if (d.playerId === state.yourId) continue;
      const name = state.players[d.playerId]?.name ?? 'A player';
      toast(
        d.status === 'kicked'
          ? `🚪 ${name} was removed by the host`
          : `👋 ${name} left the game`,
        'info'
      );
    }
    lastSeq.current = maxSeq;
  }, [state, toast]);
  return null;
}

/** One shared AudioContext for the whole session. iOS starts contexts
 *  suspended outside a user gesture (so a per-ping context never plays and
 *  never fires onended → it leaks, and iOS caps live contexts). Instead we
 *  create/resume a single context on the first touch and reuse it forever. */
let sharedAudio: AudioContext | null = null;

function unlockAudio() {
  try {
    sharedAudio ??= new AudioContext();
    if (sharedAudio.state === 'suspended') void sharedAudio.resume();
  } catch {
    // no audio available — fine
  }
}

/** Soft ping when action reaches you (PokerNow convention). */
function useTurnPing(isMyTurn: boolean) {
  const wasMyTurn = useRef(false);

  useEffect(() => {
    window.addEventListener('pointerdown', unlockAudio, { passive: true });
    return () => window.removeEventListener('pointerdown', unlockAudio);
  }, []);

  useEffect(() => {
    const audio = sharedAudio;
    if (isMyTurn && !wasMyTurn.current && audio && audio.state === 'running') {
      try {
        const osc = audio.createOscillator();
        const gain = audio.createGain();
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.08, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.25);
        osc.connect(gain).connect(audio.destination);
        osc.start();
        osc.stop(audio.currentTime + 0.25);
        osc.onended = () => {
          osc.disconnect();
          gain.disconnect();
        };
      } catch {
        // no audio available — fine
      }
    }
    wasMyTurn.current = isMyTurn;
  }, [isMyTurn]);
}

export function GameRoom({ gameId }: { gameId: string }) {
  const game = useGame(gameId);
  const { state, error } = game;
  useTurnPing(
    !!state?.yourId && state.phase === 'playing' && state.hand?.toAct === state.yourId
  );

  if (error) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-semibold">😕 {error}</p>
          <Link href="/" className="mt-4 inline-block text-emerald-600 underline">
            Start a new game
          </Link>
        </div>
      </main>
    );
  }

  if (!state) {
    return (
      <main className="flex min-h-dvh items-center justify-center">
        <p className="animate-pulse opacity-70">Finding the table…</p>
      </main>
    );
  }

  // The game is over — everyone lands on the final standings.
  if (state.phase === 'ended') {
    return <GameOverScreen state={state} />;
  }

  const me = state.yourId ? state.players[state.yourId] : null;

  // Not in the game yet — pick a name and request a seat.
  if (!me) {
    return <JoinScreen game={game} />;
  }

  if (me.status === 'left' || me.status === 'kicked') {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-4 p-6 text-center">
        <div className="text-5xl">👋</div>
        <p className="text-lg font-semibold">
          {me.status === 'left' ? 'You left the game' : 'The host removed you from the game'}
        </p>
        <p className="text-sm opacity-70">The table plays on without you.</p>
        <Link
          href="/"
          className="mt-2 rounded-xl bg-emerald-600 px-6 py-3 font-semibold text-white active:scale-95"
        >
          🃏 Play again
        </Link>
      </main>
    );
  }

  // Requested a seat, waiting for the host.
  if (me.seat === null && state.seatRequests.some((r) => r.playerId === me.id)) {
    return (
      <main className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-lg font-semibold">Hang tight, {me.name}!</p>
        <p className="opacity-70">Waiting for the host to let you in…</p>
        <span className="mt-2 inline-block h-3 w-3 animate-ping rounded-full bg-emerald-500" />
      </main>
    );
  }

  if (me.seat === null) {
    return (
      <main className="flex min-h-dvh items-center justify-center p-6 text-center">
        <div>
          <p className="text-lg font-semibold">You&apos;re not at this table.</p>
          <Link href="/" className="mt-4 inline-block text-emerald-600 underline">
            Start a new game
          </Link>
        </div>
      </main>
    );
  }

  return (
    <ToastProvider>
      <EventNotices game={game} />
      <main className="relative flex h-dvh flex-col bg-zinc-950">
        <header className="flex items-center justify-between gap-2 px-4 py-2 text-sm text-white">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">🃏 Home Game</span>
            <span className="text-xs text-white/50">
              ${state.config.smallBlind}/${state.config.bigBlind}
              {state.hand ? ` · hand #${state.hand.handNo}` : ''}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <HistoryDrawer game={game} />
            <InviteButton gameId={gameId} />
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          <Table game={game} />
        </div>

        <HostPanel game={game} />
        <ActionBar game={game} />
      </main>
    </ToastProvider>
  );
}
