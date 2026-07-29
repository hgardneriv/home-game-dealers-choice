'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import type { ClientGameState } from '@/server/redact';

const MEDALS = ['🥇', '🥈', '🥉'];

/** Full-screen final standings, shown when the game ends (host or last-player-standing). */
export function GameOverScreen({ state }: { state: ClientGameState }) {
  const buyIn = state.config.startingStack;
  const standings = Object.values(state.players)
    .filter((p) => p.status === 'seated' || p.status === 'away' || p.status === 'busted')
    .sort((a, b) => b.stack - a.stack);
  const winner = standings[0];

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-zinc-950 p-6 text-white">
      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        className="flex w-full max-w-md flex-col items-center gap-6"
      >
        <div className="text-center">
          <div className="text-5xl">{state.endedReason === 'host' ? '🛑' : '🏆'}</div>
          <h1 className="mt-3 text-2xl font-bold">
            {state.endedReason === 'host'
              ? 'The host ended the game'
              : `${winner?.name ?? 'Someone'} takes it all!`}
          </h1>
          <p className="mt-1 text-sm text-white/60">
            Final count after {state.hand ? `${state.hand.handNo} hands` : 'the session'} · buy-in
            ${buyIn}
          </p>
        </div>

        <div className="w-full overflow-hidden rounded-2xl border border-white/10 bg-white/5">
          {standings.map((p, i) => {
            const net = p.stack - buyIn;
            const isYou = p.id === state.yourId;
            return (
              <motion.div
                key={p.id}
                initial={{ opacity: 0, x: -12 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.15 + i * 0.08 }}
                className={`flex items-center gap-3 border-b border-white/5 px-4 py-3 last:border-b-0 ${
                  isYou ? 'bg-emerald-500/10' : ''
                }`}
              >
                <span className="w-7 text-center text-lg">{MEDALS[i] ?? `${i + 1}.`}</span>
                <span className="flex-1 truncate font-medium">
                  {p.isBot ? '🤖 ' : ''}
                  {p.name}
                  {isYou && <span className="ml-1 text-xs text-emerald-300">you</span>}
                </span>
                <span className="font-bold text-amber-300">${p.stack}</span>
                <span
                  className={`w-14 text-right text-sm font-semibold ${
                    net > 0 ? 'text-emerald-400' : net < 0 ? 'text-red-400' : 'text-white/40'
                  }`}
                >
                  {net > 0 ? `+$${net}` : net < 0 ? `−$${-net}` : '±$0'}
                </span>
              </motion.div>
            );
          })}
        </div>

        <Link
          href="/"
          className="w-full rounded-xl bg-emerald-600 px-4 py-3 text-center font-semibold text-white shadow-lg active:scale-95"
        >
          🃏 Play again
        </Link>
      </motion.div>
    </main>
  );
}
