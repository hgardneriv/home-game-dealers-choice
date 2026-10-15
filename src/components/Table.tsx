'use client';

import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { GameApi } from '@/hooks/useGame';
import { useOrientation } from '@/hooks/useOrientation';
import { Seat } from './Seat';
import { PlayingCard, SUIT_PATH } from './PlayingCard';
import { getVariant } from '@/engine/variants/registry';
import { reviewingLastHand } from '@/engine/types';
import {
  currentDiscardAnnouncement,
  discardAnnouncementCopy,
  drawPromptCopy,
  myDrawMax,
} from './draw-banners';

/**
 * Party felt: four-suit motif + static confetti/streamers in a data-URI
 * SVG. Backgrounds rasterize once — no filters/blurs on the table
 * (they wedge older iOS GPUs).
 */
const FELT_TILE = `url("data:image/svg+xml,${encodeURIComponent(
  `<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'>` +
    `<g fill='#000000' fill-opacity='0.075'>` +
    `<path transform='translate(18,16)' d='${SUIT_PATH.s}'/>` +
    `<path transform='translate(108,22)' d='${SUIT_PATH.c}'/>` +
    `<path transform='translate(24,102)' d='${SUIT_PATH.d}'/>` +
    `<path transform='translate(96,88)' d='${SUIT_PATH.h}'/>` +
    `</g>` +
    `<g fill='none' stroke='#d8b45c' stroke-opacity='0.14' stroke-width='1.4' stroke-linecap='round'>` +
    `<path d='M8 52 Q36 38 62 56'/>` +
    `<path d='M92 18 Q118 8 146 24'/>` +
    `<path d='M70 118 Q98 132 128 116'/>` +
    `</g>` +
    `<g>` +
    `<circle cx='72' cy='44' r='2.4' fill='#f0d78c' fill-opacity='0.22'/>` +
    `<circle cx='148' cy='70' r='1.7' fill='#e8a07a' fill-opacity='0.20'/>` +
    `<circle cx='54' cy='138' r='2' fill='#d8b45c' fill-opacity='0.20'/>` +
    `<circle cx='132' cy='128' r='1.8' fill='#f5e6c8' fill-opacity='0.18'/>` +
    `<circle cx='12' cy='68' r='1.5' fill='#e07a7a' fill-opacity='0.16'/>` +
    `<circle cx='88' cy='78' r='1.4' fill='#f0d78c' fill-opacity='0.18'/>` +
    `<path d='M40 80 l2.4 3.2 -2.4 3.2 -2.4-3.2 z' fill='#d8b45c' fill-opacity='0.18'/>` +
    `<path d='M118 98 l2.1 2.8 -2.1 2.8 -2.1-2.8 z' fill='#f0d78c' fill-opacity='0.16'/>` +
    `</g>` +
    `</svg>`
)}")`;

const FELT_LAYERS = [
  'radial-gradient(ellipse at 50% 30%, rgba(255,220,120,0.16) 0%, rgba(255,255,255,0) 56%)',
  'radial-gradient(ellipse at 18% 72%, rgba(255,170,90,0.07) 0%, rgba(255,255,255,0) 42%)',
  FELT_TILE,
  'radial-gradient(ellipse at 50% 38%, #1fa86c 0%, #0f6a40 46%, #062918 100%)',
].join(', ');

/** Mahogany rail: top sheen + fine grain streaks over a deep warm radial. */
const WOOD_LAYERS = [
  'linear-gradient(180deg, rgba(255,255,255,0.16) 0%, rgba(255,255,255,0) 20%, rgba(0,0,0,0.28) 100%)',
  'repeating-linear-gradient(95deg, rgba(0,0,0,0.14) 0px, rgba(0,0,0,0) 2px, rgba(0,0,0,0.1) 5px, rgba(80,35,12,0.18) 8px)',
  'radial-gradient(ellipse at 50% 25%, #8a4d26 0%, #5f3115 55%, #331508 100%)',
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

/**
 * Board + pot cluster. Slightly below geometric center so the pot
 * clears the hero and the wordmark can hang in the open felt under
 * the top seat. Same stack at every canvas size — landscape used to
 * pin the mark on the board (it read as a watermark and overlapped).
 */
const CENTERS: Record<string, Point> = {
  portrait: { x: 50, y: 54 },
  landscape: { x: 50, y: 54 },
};

/** Chip lands on the nameplate then vanishes — keep under the 2.5s fold-win hold. */
const AWARD_ARRIVE_MS = 1500;

function PotAward({
  amount,
  from,
  to,
  delay,
}: {
  amount: number;
  from: Point;
  to: Point;
  delay: number;
}) {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setGone(true), delay * 1000 + AWARD_ARRIVE_MS + 250);
    return () => window.clearTimeout(t);
  }, [delay]);
  if (gone) return null;

  const secs = AWARD_ARRIVE_MS / 1000;
  return (
    <motion.div
      initial={{ left: `${from.x}%`, top: `${from.y + 8}%`, opacity: 1, scale: 1 }}
      animate={{
        left: `${to.x}%`,
        // Sit on the nameplate (below the cards / caption), not on the hand.
        top: `${Math.min(92, to.y + 5)}%`,
        opacity: [1, 1, 0],
        scale: [1.15, 1.2, 0.7],
      }}
      transition={{
        delay,
        duration: secs,
        ease: 'easeInOut',
        opacity: { delay, duration: secs, times: [0, 0.7, 1] },
        scale: { delay, duration: secs, times: [0, 0.7, 1] },
      }}
      className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
    >
      <div className="relative flex flex-col items-center">
        <motion.span
          className="absolute -top-7 text-3xl leading-none"
          initial={{ opacity: 1, scale: 1, rotate: -18 }}
          animate={{ opacity: [1, 1, 0], scale: [1, 1.35, 0.5], rotate: [-18, 10, 24] }}
          transition={{ delay, duration: secs, times: [0, 0.66, 0.8] }}
        >
          🔥
        </motion.span>
        <motion.span
          className="absolute -top-7 text-3xl leading-none"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: [0, 0, 1, 0], scale: [0.5, 0.5, 1.3, 1.6] }}
          transition={{ delay, duration: secs + 0.4, times: [0, 0.6, 0.76, 1] }}
        >
          💨
        </motion.span>
        <div className="flex items-center gap-1.5 rounded-full bg-black/75 px-2.5 py-1 shadow-lg">
          <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-white/70 bg-amber-500" />
          <span className="text-sm font-bold text-amber-200">${amount}</span>
        </div>
      </div>
    </motion.div>
  );
}

const FELT_SUITS: { suit: 's' | 'h' | 'd' | 'c'; red: boolean }[] = [
  { suit: 's', red: false },
  { suit: 'h', red: true },
  { suit: 'd', red: true },
  { suit: 'c', red: false },
];

/** Glossy suit — SVG gradients only, no CSS filter. */
function FeltSuit({
  suit,
  red,
  gid,
}: {
  suit: 's' | 'h' | 'd' | 'c';
  red: boolean;
  gid: string;
}) {
  const fill = `${gid}-fill`;
  return (
    <span className="relative inline-flex h-6 w-6 items-center justify-center sm:h-8 sm:w-8">
      <span
        className="absolute inset-[-30%] rounded-full"
        style={{
          background: red
            ? 'radial-gradient(closest-side, rgba(255,196,90,0.42) 0%, rgba(255,196,90,0) 74%)'
            : 'radial-gradient(closest-side, rgba(255,214,120,0.26) 0%, rgba(255,214,120,0) 74%)',
        }}
      />
      <svg viewBox="0 0 24 24" className="relative h-full w-full" aria-hidden>
        <defs>
          <linearGradient id={fill} x1="0.28" y1="0" x2="0.72" y2="1">
            {red ? (
              <>
                <stop offset="0%" stopColor="#ff9a9a" />
                <stop offset="36%" stopColor="#e11d2a" />
                <stop offset="100%" stopColor="#6d0b12" />
              </>
            ) : (
              <>
                <stop offset="0%" stopColor="#6a6a6a" />
                <stop offset="38%" stopColor="#1c1c1c" />
                <stop offset="100%" stopColor="#050505" />
              </>
            )}
          </linearGradient>
          <clipPath id={`${gid}-clip`}>
            <path d={SUIT_PATH[suit]} />
          </clipPath>
        </defs>
        <path d={SUIT_PATH[suit]} fill={`url(#${fill})`} />
        <ellipse
          cx="9"
          cy="7.5"
          rx="5.2"
          ry="4.2"
          fill="#fff"
          opacity="0.38"
          clipPath={`url(#${gid}-clip)`}
        />
      </svg>
    </span>
  );
}

function FeltLogo({ marquee }: { marquee: string }) {
  const rawId = useId().replace(/:/g, '');
  const word = {
    fontFamily: 'var(--font-cinzel), Georgia, "Times New Roman", serif',
    paddingLeft: '0.14em',
  } as const;
  return (
    <div className="pointer-events-none relative select-none text-center">
      <div
        className="absolute left-1/2 top-[62%] h-44 w-[28rem] max-w-[80vw] -translate-x-1/2 -translate-y-1/2"
        style={{
          background:
            'radial-gradient(closest-side, rgba(255,214,110,0.26) 0%, rgba(216,180,92,0) 100%)',
        }}
      />
      <div className="relative flex items-center justify-center gap-1.5 sm:gap-2">
        {FELT_SUITS.map(({ suit, red }) => (
          <FeltSuit key={suit} suit={suit} red={red} gid={`${rawId}-${suit}`} />
        ))}
      </div>
      <div
        className="relative mt-0.5 whitespace-nowrap text-[1.55rem] font-bold tracking-[0.14em] text-[#e4c05c] sm:text-[2.2rem] sm:tracking-[0.18em]"
        style={word}
      >
        POKER PARTY
      </div>
      <div className="relative mt-0.5 flex items-center justify-center gap-2 whitespace-nowrap">
        <span className="h-px w-10 bg-gradient-to-r from-transparent to-amber-200/55 sm:w-16" />
        <span
          className="text-[11px] tracking-[0.38em] text-amber-100/70 sm:text-[13px] sm:tracking-[0.42em]"
          style={{ paddingLeft: '0.38em' }}
        >
          {marquee}
        </span>
        <span className="h-px w-10 bg-gradient-to-l from-transparent to-amber-200/55 sm:w-16" />
      </div>
    </div>
  );
}

function EmptySlot() {
  return (
    <div
      className="w-12 aspect-[20/29] rounded-[4px] border border-amber-400/40 bg-[#0c2318]/90 sm:w-14"
      style={{
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.6), inset 0 0 0 3px rgba(216,180,92,0.22)',
      }}
    />
  );
}

/** In-between turn result — the shape 'in-between-result' events carry. */
interface InBetweenResult {
  playerId: string;
  cards: [string, string];
  /** null on a pass (no card is burned) — those never open a reveal. */
  third: string | null;
  outcome: 'win' | 'lose' | 'post' | 'pass';
  amount: number;
  /** Present only when the first card was a called ace. */
  aceLow?: boolean;
}


export function Table({ game }: { game: GameApi }) {
  const state = game.state!;
  const hand = state.hand;
  const orientation = useOrientation();
  const center = CENTERS[orientation];
  const positions = LAYOUTS[orientation];
  const mySeat = state.yourId ? (state.players[state.yourId]?.seat ?? 0) : 0;
  const slotFor = (seatIndex: number) => (seatIndex - mySeat + 6) % 6;
  const posFor = (seatIndex: number) => positions[slotFor(seatIndex)];

  const choosing = state.phase === 'choosing' ? state.choosing : null;
  // While the dealer picks, the marquee flips back to the brand.
  const variant = hand && !choosing ? getVariant(hand.variant) : null;
  const marquee = variant ? variant.marquee : "DEALER'S CHOICE";
  const result = hand?.result ?? null;

  // Per-turn result reveal (in-between): the freshest result event still
  // inside its display window keeps the played card on the table for all.
  const revealCfg = variant?.resultReveal ?? null;
  const revealEvent = (() => {
    if (!revealCfg) return null;
    let latest = null;
    for (const e of state.events) {
      if (e.type === revealCfg.eventType && (revealCfg.shows?.(e.data) ?? true)) latest = e;
    }
    if (!latest) return null;
    return game.serverNow() - latest.at < revealCfg.ms ? latest : null;
  })();
  const reveal = revealEvent ? (revealEvent.data as InBetweenResult) : null;
  const firstAceCall = reveal
    ? reveal.aceLow === undefined
      ? undefined
      : reveal.aceLow
        ? 'low'
        : 'high'
    : hand?.aceCall;

  // Tick while a reveal is showing so it dismisses on schedule.
  const [, forceTick] = useState(0);
  const revealSeq = revealEvent?.seq ?? null;
  useEffect(() => {
    if (revealSeq === null) return;
    const t = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [revealSeq]);
  const winnerLines = (() => {
    if (!result || !hand) return [];
    const total: Record<string, number> = {};
    for (const pot of result.pots) {
      for (const w of pot.winners) total[w] = (total[w] ?? 0) + Math.floor(pot.amount / pot.winners.length);
    }
    return Object.entries(total).map(([id, amt]) => {
      const name = state.players[id]?.name ?? '?';
      const description = result.descriptions[id];
      return description ? `${name} wins $${amt} — ${description}` : `${name} wins $${amt}`;
    });
  })();
  const showHandBanner = winnerLines.length > 0 || reviewingLastHand(state);
  const drawMax = myDrawMax(hand?.legalActions ?? null);
  const myDrawTurn =
    !showHandBanner &&
    state.phase === 'playing' &&
    !!state.yourId &&
    hand?.toAct === state.yourId &&
    drawMax !== null;
  const discardNote = currentDiscardAnnouncement(state.events, hand);
  const discardLine = discardNote
    ? discardAnnouncementCopy(state.players[discardNote.playerId]?.name ?? 'Player', discardNote.count)
    : null;
  const showDrawBanners = !showHandBanner && (myDrawTurn || !!discardLine);
  const payouts: Record<string, number> = {};
  if (result) {
    for (const pot of result.pots) {
      const share = Math.floor(pot.amount / pot.winners.length);
      for (const w of pot.winners) payouts[w] = (payouts[w] ?? 0) + share;
    }
  }

  return (
    <div
      className="absolute inset-2"
      style={{ borderRadius: orientation === 'landscape' ? '45% / 42%' : '42% / 46%' }}
    >
      {/* Wood rail */}
      <div
        className="absolute inset-0 shadow-[0_10px_30px_rgba(0,0,0,0.5)]"
        style={{ borderRadius: 'inherit', backgroundImage: WOOD_LAYERS }}
      />
      {/* Dark seam, then gold trim, between wood and felt */}
      <div
        className="pointer-events-none absolute inset-[10px] z-10 border-2 border-black/50"
        style={{ borderRadius: 'inherit' }}
      />
      <div
        className="pointer-events-none absolute inset-[12px] z-10 border border-amber-300/60"
        style={{ borderRadius: 'inherit' }}
      />
      {/* Felt */}
      <div
        className="absolute inset-[14px] shadow-[inset_0_0_80px_rgba(0,0,0,0.6)]"
        style={{
          borderRadius: 'inherit',
          backgroundImage: FELT_LAYERS,
          backgroundSize: 'auto, auto, 120px 120px, auto',
          backgroundRepeat: 'no-repeat, no-repeat, repeat, no-repeat',
        }}
      />
      {/* Double gold pinstripe inside the rail — the only ornament, kept clean */}
      <div
        className="pointer-events-none absolute inset-[26px] border-2 border-amber-300/30"
        style={{ borderRadius: 'inherit' }}
      />
      <div
        className="pointer-events-none absolute inset-[32px] border border-amber-300/15"
        style={{ borderRadius: 'inherit' }}
      />

      {/* Board + pot. Wordmark hangs just above the slots (out of flow) so
          logo→cards stays tight while cards→pot keeps a real gap — same
          stack on phone, narrow, and full-screen. Winner / draw copy
          overlays the mark (does not move it): one line covers the
          marquee, extra lines grow up over POKER PARTY. */}
      <div
        className="absolute flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-2"
        style={{ left: `${center.x}%`, top: `${center.y}%` }}
      >
        <div className="pointer-events-none absolute bottom-full left-1/2 z-0 mb-[18px] w-max -translate-x-1/2 sm:mb-[22px]">
          <FeltLogo marquee={marquee} />
        </div>
        <AnimatePresence>
          {(showHandBanner || showDrawBanners) && (
            <motion.div
              key={
                showHandBanner
                  ? `banner-${hand?.handNo ?? 'end'}`
                  : `draw-${discardLine ?? 'prompt'}-${myDrawTurn ? drawMax : ''}`
              }
              initial={{ opacity: 0, y: 8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0 }}
              transition={{ delay: showHandBanner ? 0.35 : 0 }}
              className="absolute bottom-full left-1/2 z-30 mb-[18px] flex w-max max-w-[min(86vw,28rem)] -translate-x-1/2 flex-col items-center sm:mb-[22px]"
            >
              <div className="flex flex-col items-center rounded-xl border border-amber-400/40 bg-black/80 px-4 py-2 text-center shadow-xl">
                {winnerLines.map((line) => (
                  <span key={line} className="text-sm font-semibold text-amber-300">
                    🏆 {line}
                  </span>
                ))}
                {reviewingLastHand(state) && (
                  <div className="mt-1 text-xs font-medium text-white/80">
                    Last Hand - Press Results to continue
                  </div>
                )}
                {showDrawBanners && discardLine && (
                  <span className="text-sm font-semibold text-amber-200">{discardLine}</span>
                )}
                {showDrawBanners && myDrawTurn && drawMax !== null && (
                  <span className={`text-sm font-semibold text-amber-300 ${discardLine ? 'mt-1' : ''}`}>
                    🂠 {drawPromptCopy(drawMax)}
                  </span>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        {state.phase === 'lobby' ? (
          <div className="text-center text-white/85">
            <div className="text-sm font-medium">Waiting for players…</div>
            <div className="mt-1 text-xs opacity-70">
              ante ${state.config.ante} · buy-in ${state.config.startingStack}
            </div>
          </div>
        ) : (
          <>
            <div className="flex gap-1.5">
              {variant?.id === 'in-between'
                ? // Three slots dealt outside-in: up-cards in 1 and 3, the
                  // played card lands "in between" and stays for the reveal.
                  (reveal
                    ? [reveal.cards[0], reveal.third ?? undefined, reveal.cards[1]]
                    : [hand?.board[0], undefined, hand?.board[1]]
                  ).map((card, i) =>
                    card ? (
                      i === 1 ? (
                        <div
                          key={`mid-${card}`}
                          className={`rounded-[5px] ring-2 ${
                            reveal?.outcome === 'win'
                              ? 'ring-emerald-400 shadow-[0_0_14px_rgba(52,211,153,0.7)]'
                              : reveal?.outcome === 'pass'
                                ? 'ring-amber-300 shadow-[0_0_14px_rgba(252,211,77,0.55)]'
                                : 'ring-red-400 shadow-[0_0_14px_rgba(248,113,113,0.7)]'
                          }`}
                        >
                          <PlayingCard card={card} size="board" dealt />
                        </div>
                      ) : (
                        <PlayingCard
                          key={card}
                          card={card}
                          size="board"
                          dealt
                          aceCall={i === 0 ? firstAceCall : undefined}
                        />
                      )
                    ) : (
                      <EmptySlot key={`slot${i}`} />
                    )
                  )
                : (variant === null || variant.layoutHint === 'board') &&
                  [0, 1, 2, 3, 4].map((i) => {
                    const card = hand?.board[i];
                    return card ? (
                      <PlayingCard key={card} card={card} size={variant?.layoutHint === 'board' ? 'board' : 'md'} dealt />
                    ) : (
                      <EmptySlot key={`slot${i}`} />
                    );
                  })}
            </div>
            {/* In-between turn outcome — announced to the whole table. */}
            <AnimatePresence>
              {reveal && (
                <motion.div
                  key={`ib-${revealSeq}`}
                  initial={{ opacity: 0, y: 6, scale: 0.92 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="rounded-full bg-black/70 px-3 py-1 text-sm font-semibold shadow"
                >
                  {(() => {
                    const name = state.players[reveal.playerId]?.name ?? 'Player';
                    switch (reveal.outcome) {
                      case 'win':
                        return <span className="text-emerald-300">🎉 {name} wins ${reveal.amount}!</span>;
                      case 'lose':
                        return <span className="text-red-300">💸 {name} loses ${reveal.amount}</span>;
                      case 'post':
                        return <span className="text-red-300">🔥 {name} pays double — ${reveal.amount}!</span>;
                      default:
                        return <span className="text-white/80">{name} passes</span>;
                    }
                  })()}
                </motion.div>
              )}
            </AnimatePresence>
            {state.carryPot > 0 && (
              <div className="rounded-full bg-black/45 px-3 py-1 text-xs text-amber-200/90 shadow">
                ↪ ${state.carryPot} rides on the next hand
              </div>
            )}
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

      {/* Pot flies to each winner, then fades so it never sits on their cards. */}
      <AnimatePresence>
        {result &&
          hand &&
          Object.entries(payouts).map(([id, amount], i) => {
            const seat = state.players[id]?.seat ?? 0;
            const p = posFor(seat);
            return (
              <PotAward
                key={`award-${hand.handNo}-${id}`}
                amount={amount}
                from={center}
                to={p}
                delay={0.15 * i}
              />
            );
          })}
      </AnimatePresence>

      {/* DOUBLE BURN — hitting the post costs double, and everyone hears about it */}
      <AnimatePresence>
        {reveal?.outcome === 'post' && (
          <motion.div
            key={`burn-${revealSeq}`}
            initial={{ x: '-50%', scale: 0.3, opacity: 0, rotate: -8 }}
            animate={{ x: '-50%', scale: 1, opacity: 1, rotate: 0 }}
            exit={{ opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 13 }}
            className="pointer-events-none absolute left-1/2 z-30 whitespace-nowrap text-3xl font-black tracking-wider sm:text-5xl"
            style={{ top: '18%' }}
          >
            <span
              className="bg-gradient-to-b from-amber-300 via-orange-500 to-red-600 bg-clip-text text-transparent"
              style={{ textShadow: '0 3px 10px rgba(0,0,0,0.55)' }}
            >
              💥 DOUBLE BURN!!!
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Seats — bet + D render inside Seat, beside each player's cards. */}
      {state.seats.map((playerId, seatIndex) => {
        const pos = posFor(seatIndex);
        return (
          <div
            key={seatIndex}
            className="absolute z-10 -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
          >
            <Seat
              game={game}
              seatIndex={seatIndex}
              playerId={playerId}
              visualSlot={slotFor(seatIndex)}
              payout={playerId ? (payouts[playerId] ?? 0) : 0}
            />
          </div>
        );
      })}
    </div>
  );
}
