'use client';

import { AnimatePresence, motion } from 'motion/react';
import type { GameApi } from '@/hooks/useGame';
import { useOrientation } from '@/hooks/useOrientation';
import { Seat } from './Seat';
import { PlayingCard, SUIT_PATH } from './PlayingCard';

/**
 * Felt texture: a sparse diagonal tile of dark suit motifs baked into a
 * data-URI SVG. Static backgrounds rasterize once — deliberately no
 * filters/blurs anywhere on the table (they wedge older iOS GPUs).
 */
const FELT_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='120' height='120'>` +
    `<g fill='#000000' fill-opacity='0.06'>` +
    `<path transform='translate(16,12)' d='${SUIT_PATH.s}'/>` +
    `<path transform='translate(76,72)' d='${SUIT_PATH.c}'/>` +
    `</g></svg>`
)}")`;

const FELT_LAYERS = [
  'radial-gradient(ellipse at 50% 35%, rgba(255,255,255,0.10) 0%, rgba(255,255,255,0) 60%)',
  FELT_TILE,
  'radial-gradient(ellipse at 50% 38%, #1f8354 0%, #146240 45%, #093d25 100%)',
].join(', ');

interface Point {
  x: number;
  y: number;
}

/** Seat positions (percent of table area), index 0 = hero bottom-center. */
const LAYOUTS: Record<string, Point[]> = {
  landscape: [
    { x: 50, y: 87 },
    { x: 12, y: 68 },
    { x: 12, y: 24 },
    { x: 50, y: 9 },
    { x: 88, y: 24 },
    { x: 88, y: 68 },
  ],
  portrait: [
    { x: 50, y: 86 },
    { x: 16, y: 64 },
    { x: 17, y: 28 },
    { x: 50, y: 8 },
    { x: 83, y: 28 },
    { x: 84, y: 64 },
  ],
};

const CENTER: Point = { x: 50, y: 42 };

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function BetChip({ amount, at }: { amount: number; at: Point }) {
  return (
    <motion.div
      layout
      initial={{ scale: 0.4, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      exit={{ left: `${CENTER.x}%`, top: `${CENTER.y}%`, opacity: 0, transition: { duration: 0.45 } }}
      transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
      style={{ left: `${at.x}%`, top: `${at.y}%` }}
    >
      <div className="flex items-center gap-1 rounded-full bg-black/45 py-0.5 pl-0.5 pr-2 shadow">
        <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-white/70 bg-amber-500 shadow-inner" />
        <span className="text-xs font-bold text-amber-300">{amount}</span>
      </div>
    </motion.div>
  );
}

export function Table({ game }: { game: GameApi }) {
  const state = game.state!;
  const hand = state.hand;
  const orientation = useOrientation();
  const positions = LAYOUTS[orientation];
  const mySeat = state.yourId ? (state.players[state.yourId]?.seat ?? 0) : 0;
  const posFor = (seatIndex: number) => positions[(seatIndex - mySeat + 6) % 6];

  const result = hand?.result ?? null;
  const winnersLine = (() => {
    if (!result || !hand) return null;
    const total: Record<string, number> = {};
    for (const pot of result.pots) {
      for (const w of pot.winners) total[w] = (total[w] ?? 0) + Math.floor(pot.amount / pot.winners.length);
    }
    const parts = Object.entries(total).map(([id, amt]) => {
      const name = state.players[id]?.name ?? '?';
      const description = result.descriptions[id];
      return description ? `${name} wins $${amt} — ${description}` : `${name} wins $${amt}`;
    });
    return parts.join('  ·  ');
  })();

  return (
    <div
      className="absolute inset-2 border-[10px] border-amber-950/90 shadow-[inset_0_0_60px_rgba(0,0,0,0.55),0_10px_30px_rgba(0,0,0,0.5)]"
      style={{
        borderRadius: orientation === 'landscape' ? '45% / 42%' : '42% / 46%',
        backgroundImage: FELT_LAYERS,
        backgroundSize: 'auto, 120px 120px, auto',
        backgroundRepeat: 'no-repeat, repeat, no-repeat',
      }}
    >
      {/* Gold pinstripe hugging the wooden rail */}
      <div
        className="pointer-events-none absolute inset-1 border border-amber-300/25"
        style={{ borderRadius: 'inherit' }}
      />
      {/* Inner rail (betting) line */}
      <div
        className="pointer-events-none absolute inset-4 border border-white/10"
        style={{ borderRadius: 'inherit' }}
      />

      {/* Felt logo — an embroidered-style gold badge */}
      <div className="pointer-events-none absolute left-1/2 top-[62%] z-0 -translate-x-1/2 -translate-y-1/2 select-none text-center">
        <div className="rounded-[50%] border border-amber-200/20 px-8 py-3 sm:px-10 sm:py-4">
          <div
            className="text-2xl leading-none tracking-[0.5em] text-black/60 sm:text-[28px]"
            style={{ paddingLeft: '0.5em' }}
          >
            ♠&nbsp;♥&nbsp;♦&nbsp;♣
          </div>
          <div
            className="mt-0.5 bg-gradient-to-b from-amber-50/95 via-amber-300/85 to-amber-500/70 bg-clip-text text-xl font-black tracking-[0.3em] text-transparent sm:text-3xl"
            style={{ fontFamily: 'Georgia, "Times New Roman", serif', paddingLeft: '0.3em' }}
          >
            HOME GAME
          </div>
          <div
            className="mt-0.5 text-[10px] tracking-[0.4em] text-white/50 sm:text-xs"
            style={{ paddingLeft: '0.4em' }}
          >
            TEXAS HOLD&apos;EM
          </div>
        </div>
      </div>

      {/* Board + pot */}
      <div
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        {state.phase === 'lobby' ? (
          <div className="text-center text-white/85">
            <div className="text-sm font-medium">Waiting for players…</div>
            <div className="mt-1 text-xs opacity-70">
              blinds ${state.config.smallBlind}/${state.config.bigBlind} · buy-in $
              {state.config.startingStack}
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5">
              {[0, 1, 2, 3, 4].map((i) => {
                const card = hand?.board[i];
                return card ? (
                  <PlayingCard key={card} card={card} size="md" dealt />
                ) : (
                  <div
                    key={`slot${i}`}
                    className="w-12 aspect-[20/29] rounded-[4px] border border-white/15 bg-black/10 sm:w-14"
                  />
                );
              })}
            </div>
            <AnimatePresence>
              {hand && hand.potTotal > 0 && !result && (
                <motion.div
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-1.5 rounded-full bg-black/45 px-3 py-1 shadow"
                >
                  <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-white/70 bg-amber-500" />
                  <span className="text-sm font-bold text-amber-300">${hand.potTotal}</span>
                </motion.div>
              )}
            </AnimatePresence>
            {state.phase === 'paused' && (
              <div className="rounded-full bg-black/55 px-3 py-1 text-sm text-white">⏸ Paused</div>
            )}
          </>
        )}
      </div>

      {/* Pot flying to the winner */}
      <AnimatePresence>
        {result && hand && (
          <motion.div
            key={`award-${hand.handNo}`}
            initial={{ left: `${CENTER.x}%`, top: `${CENTER.y + 8}%`, opacity: 1, scale: 1 }}
            animate={(() => {
              const seat = state.players[result.pots[0]?.winners[0]]?.seat ?? 0;
              const p = posFor(seat);
              // Land just above the winner's plate, not on top of it.
              return { left: `${p.x}%`, top: `${Math.max(4, p.y - 9)}%`, scale: 0.9 };
            })()}
            exit={{ opacity: 0 }}
            transition={{ delay: 0.5, duration: 0.7, ease: 'easeInOut' }}
            className="absolute z-20 -translate-x-1/2 -translate-y-1/2"
          >
            <div className="flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1 shadow-lg">
              <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-white/70 bg-amber-500" />
              <span className="text-sm font-bold text-amber-300">
                ${result.pots.reduce((a, p) => a + p.amount, 0)}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Winner banner */}
      <AnimatePresence>
        {winnersLine && (
          <motion.div
            key={`banner-${hand?.handNo}`}
            initial={{ opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ delay: 0.35 }}
            className="absolute left-1/2 z-30 w-max max-w-[86%] -translate-x-1/2 rounded-xl border border-amber-400/40 bg-black/80 px-4 py-2 text-center shadow-xl"
            style={{ top: `${CENTER.y + 15}%` }}
          >
            <span className="text-sm font-semibold text-amber-300">🏆 {winnersLine}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Dealer button */}
      {hand && (
        <motion.div
          layout
          transition={{ type: 'spring', stiffness: 300, damping: 25 }}
          className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
          style={(() => {
            const p = lerp(posFor(hand.buttonSeat), CENTER, 0.22);
            return { left: `${p.x - 4}%`, top: `${p.y}%` };
          })()}
        >
          <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-black text-black shadow">
            D
          </span>
        </motion.div>
      )}

      {/* Bet chips between each seat and the pot */}
      <AnimatePresence>
        {hand &&
          !result &&
          Object.entries(hand.committed).map(([playerId, amount]) => {
            const seat = state.players[playerId]?.seat;
            if (amount <= 0 || seat === null || seat === undefined) return null;
            return (
              <BetChip
                key={`${playerId}-${hand.street}`}
                amount={amount}
                at={lerp(posFor(seat), CENTER, 0.32)}
              />
            );
          })}
      </AnimatePresence>

      {/* Seats */}
      {state.seats.map((playerId, seatIndex) => {
        const pos = posFor(seatIndex);
        return (
          <div
            key={seatIndex}
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
          >
            <Seat game={game} seatIndex={seatIndex} playerId={playerId} />
          </div>
        );
      })}
    </div>
  );
}
