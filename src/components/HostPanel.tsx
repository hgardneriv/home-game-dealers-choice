'use client';

import { useState } from 'react';
import type { GameApi } from '@/hooks/useGame';

export function HostPanel({ game }: { game: GameApi }) {
  const state = game.state!;
  const me = state.yourId ? state.players[state.yourId] : null;
  const [open, setOpen] = useState(false);
  const [confirmKick, setConfirmKick] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  if (!me?.isHost) return null;

  const requests = state.seatRequests;
  const bots = Object.values(state.players).filter((p) => p.isBot && p.seat !== null);
  const kickable = Object.values(state.players).filter(
    (p) => p.seat !== null && p.id !== me.id && !p.isBot
  );
  const seated = state.seats.filter(Boolean).length;

  return (
    <div className="border-t border-white/10 bg-zinc-950 text-white">
      {/* Pending seat requests always surface immediately. */}
      {requests.map((r) => (
        <div key={r.playerId} className="flex items-center gap-2 px-4 py-2">
          <span className="flex-1 text-sm">
            🙋 <b>{r.name}</b> wants to join
          </span>
          <button
            className="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm font-semibold"
            onClick={() => game.seatOp('approve', r.playerId)}
          >
            Approve
          </button>
          <button
            className="rounded-lg bg-zinc-700 px-3 py-1.5 text-sm"
            onClick={() => game.seatOp('deny', r.playerId)}
          >
            Deny
          </button>
        </div>
      ))}

      <div className="flex items-center gap-2 px-4 py-2">
        {state.phase === 'lobby' ? (
          <>
            <button
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-bold disabled:opacity-40"
              disabled={seated < 2}
              onClick={() => game.hostOp('start')}
            >
              ▶ Start game
            </button>
            <span className="text-xs opacity-60">
              {seated < 2 ? 'need at least 2 players' : `${seated} seated`}
            </span>
          </>
        ) : (
          <span className="text-xs opacity-60">Host controls</span>
        )}
        <div className="flex-1" />
        <button className="text-sm opacity-80" onClick={() => setOpen((o) => !o)}>
          {open ? '▾ less' : '▸ more'}
        </button>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-4 pb-3 text-sm">
          <div className="flex flex-wrap gap-2">
            {state.phase === 'paused' ? (
              <button
                className="rounded-lg bg-emerald-700 px-3 py-1.5"
                onClick={() => game.hostOp('resume')}
              >
                ▶ Resume
              </button>
            ) : (
              <button
                className="rounded-lg bg-zinc-700 px-3 py-1.5"
                disabled={state.phase === 'lobby'}
                onClick={() => game.hostOp('pause')}
              >
                ⏸ Pause {state.pauseAfterHand ? '(after this hand)' : ''}
              </button>
            )}
            <button
              className="rounded-lg bg-zinc-700 px-3 py-1.5 disabled:opacity-40"
              disabled={!state.seats.includes(null)}
              onClick={() => game.hostOp('addBot')}
            >
              + Add bot
            </button>
            {confirmEnd ? (
              <span className="flex items-center gap-1">
                <button
                  className="rounded-lg bg-red-700 px-3 py-1.5 font-semibold"
                  onClick={() => {
                    game.hostOp('endGame');
                    setConfirmEnd(false);
                  }}
                >
                  Really end the game?
                </button>
                <button
                  className="rounded-lg bg-zinc-700 px-2 py-1.5"
                  onClick={() => setConfirmEnd(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="rounded-lg bg-red-900/70 px-3 py-1.5"
                onClick={() => setConfirmEnd(true)}
              >
                🛑 End game
              </button>
            )}
            {bots.map((b) => (
              <button
                key={b.id}
                className="rounded-lg bg-zinc-800 px-3 py-1.5"
                onClick={() => game.hostOp('removeBot', b.id)}
              >
                − {b.name}
              </button>
            ))}
          </div>
          {kickable.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="opacity-60">Kick:</span>
              {kickable.map((p) =>
                confirmKick === p.id ? (
                  <span key={p.id} className="flex items-center gap-1">
                    <button
                      className="rounded-lg bg-red-700 px-3 py-1.5 font-semibold"
                      onClick={() => {
                        game.hostOp('kick', p.id);
                        setConfirmKick(null);
                      }}
                    >
                      Really kick {p.name}?
                    </button>
                    <button
                      className="rounded-lg bg-zinc-700 px-2 py-1.5"
                      onClick={() => setConfirmKick(null)}
                    >
                      Cancel
                    </button>
                  </span>
                ) : (
                  <button
                    key={p.id}
                    className="rounded-lg bg-red-900/70 px-3 py-1.5"
                    onClick={() => setConfirmKick(p.id)}
                  >
                    {p.name} ✕
                  </button>
                )
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
