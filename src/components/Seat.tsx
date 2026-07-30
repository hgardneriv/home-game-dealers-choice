'use client';

import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { GameApi } from '@/hooks/useGame';
import { getVariant } from '@/engine/variants/registry';
import { handLabel } from '@/engine/hand-label';
import { PlayingCard } from './PlayingCard';

export function Seat({
  game,
  playerId,
}: {
  game: GameApi;
  playerId: string | null;
}) {
  const state = game.state!;
  const hand = state.hand;
  const player = playerId ? state.players[playerId] : null;

  const isActing = !!player && hand?.toAct === player.id && state.phase === 'playing';

  // Smooth countdown: tick every 250ms while acting; the bar interpolates.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!isActing) return;
    const t = setInterval(() => forceTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [isActing]);

  if (!player) {
    return (
      <div className="flex h-14 w-20 items-center justify-center rounded-2xl border border-dashed border-white/20 text-[11px] text-white/40">
        open seat
      </div>
    );
  }

  const inHand = hand?.inHand.includes(player.id) ?? false;
  const folded = hand?.folded.includes(player.id) ?? false;
  const allIn = hand?.allIn.includes(player.id) ?? false;
  const isYou = player.id === state.yourId;
  const isWinner =
    (hand?.result?.pots.some((p) => p.winners.includes(player.id)) ?? false) &&
    state.phase !== 'playing';
  const revealed = hand?.result?.revealed[player.id];
  // Empty = nothing to show (no-peek hides even your own down cards) — fall
  // back to card backs rather than an empty seat.
  const showCardsRaw = isYou ? hand?.myCards : revealed;
  const showCards = showCardsRaw && showCardsRaw.length > 0 ? showCardsRaw : null;
  const description = hand?.result?.descriptions[player.id];

  const timerFraction = (() => {
    if (!isActing || !hand?.actionDeadline) return null;
    const total = state.config.actionTimeMs;
    const left = hand.actionDeadline - game.serverNow();
    return Math.max(0, Math.min(1, left / total));
  })();

  // Hidden hands: face-up cards (stud up-cards etc.) plus backs for the rest.
  const cardCount = hand?.cardCounts[player.id] ?? 0;
  const publicCards = hand?.publicCards[player.id] ?? [];
  const hiddenCount = Math.max(0, cardCount - publicCards.length);

  const variant = hand ? getVariant(hand.variant) : null;
  const isWildCard = (card: string) => variant?.wildRanks?.includes(card[0]) ?? false;

  // Casino-machine courtesy: name any made hand as it develops. Everyone sees
  // a label built from this seat's FACE-UP cards; you additionally see one
  // from everything you know (your own view only — never serialized).
  const liveLabel = (() => {
    if (!hand || state.phase !== 'playing' || !inHand || folded) return null;
    const cards = isYou ? (hand.myCards ?? []) : publicCards;
    return handLabel(hand.variant, cards, hand.board);
  })();

  return (
    <motion.div
      // Your own folded seat stays a bit more legible so you can read your cards.
      animate={{ opacity: folded ? (isYou ? 0.65 : 0.45) : 1 }}
      // Your seat gets an ornate gold-trimmed plaque; opponents stay compact.
      className={`flex w-max min-w-24 max-w-36 flex-col items-center sm:max-w-48 ${
        isYou
          ? 'rounded-xl border border-amber-400/50 bg-black/40 px-2 pb-1 pt-2 shadow-[0_0_0_3px_rgba(0,0,0,0.35),inset_0_0_0_2px_rgba(216,180,92,0.15),0_4px_14px_rgba(0,0,0,0.45)]'
          : ''
      }`}
    >
      {/* Cards peeking above the plate. After folding, you (and only you)
          still see your own cards greyed out — to watch what might have been.
          Face-up cards (yours, or anyone's at showdown) sit fully clear of
          the plate so the bottom index isn't cut off; face-down backs tuck. */}
      <div
        className={`z-0 flex ${
          Math.max(cardCount, showCards?.length ?? 0) > 2 ? '-space-x-3' : 'gap-0.5'
        } ${showCards ? 'mb-1' : '-mb-2'} ${folded ? 'opacity-70 grayscale' : ''}`}
      >
        {inHand && !folded && !showCards && (
          <>
            {publicCards.map((card) => (
              <PlayingCard key={card} card={card} size="sm" dealt wild={isWildCard(card)} />
            ))}
            {Array.from({ length: hiddenCount }).map((_, i) => (
              <PlayingCard key={`back-${i}`} size="sm" />
            ))}
          </>
        )}
        {inHand && showCards && (!folded || isYou) && (
          <>
            {showCards.map((card, i) => (
              <PlayingCard
                key={card}
                card={card}
                size={isYou ? 'md' : 'sm'}
                dealt
                wild={isWildCard(card)}
                // Shade your own table-hidden cards so you always know which
                // of your cards the others can't see — but only when the hand
                // MIXES up and down cards (stud). In all-down games (hold'em,
                // draw, guts) every card is hidden and the tag is just noise.
                facedown={
                  isYou &&
                  !!hand?.myFaceUp?.includes(true) &&
                  hand?.myFaceUp?.[i] === false
                }
              />
            ))}
            {/* No-peek: your flipped cards plus backs for the rest. */}
            {isYou &&
              Array.from({ length: Math.max(0, cardCount - showCards.length) }).map((_, i) => (
                <PlayingCard key={`own-back-${i}`} size="sm" />
              ))}
          </>
        )}
      </div>

      {/* Plate */}
      <div
        // No backdrop-blur here: a blur layer per seat over the felt gradient,
        // re-sampled every frame while the timer animates, can wedge the GPU
        // process on older iOS Safari (black screen). Solid tint reads the same.
        className={`relative z-10 w-full overflow-hidden rounded-xl border px-2 py-1.5 text-center shadow-lg transition-colors ${
          isWinner
            ? 'border-amber-300 bg-amber-600/40'
            : isActing
              ? 'border-amber-400 bg-black/75'
              : 'border-white/15 bg-black/70'
        }`}
      >
        <div className="truncate text-xs font-semibold text-white">
          {player.isBot ? '🤖 ' : ''}
          {player.name}
          {isYou ? <span className="opacity-60"> · you</span> : ''}
        </div>
        <div className="text-xs font-bold text-amber-300">
          {player.status === 'busted' ? (
            <span className="text-red-400">busted</span>
          ) : allIn && state.phase === 'playing' ? (
            <span className="text-red-300">ALL IN</span>
          ) : (
            <>${player.stack}</>
          )}
          {player.status === 'away' && <span className="ml-1">💤</span>}
        </div>

        {/* Turn timer bar */}
        {timerFraction !== null && (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-white/10">
            <div
              className={`h-full w-full origin-left ${
                timerFraction > 0.4
                  ? 'bg-emerald-400'
                  : timerFraction > 0.15
                    ? 'bg-amber-400'
                    : 'bg-red-500'
              }`}
              // scaleX, not width: compositor-only, no layout/repaint per tick.
              style={{ transform: `scaleX(${timerFraction})`, transition: 'transform 250ms linear' }}
            />
          </div>
        )}
      </div>

      {/* Live made-hand label (phase 'playing' only — never fights the
          showdown description below). */}
      {liveLabel && (
        <div className="z-10 mt-0.5 whitespace-nowrap rounded bg-black/60 px-1.5 text-[10px] font-medium text-emerald-300">
          {liveLabel}
        </div>
      )}

      {/* Showdown hand description */}
      {description && isWinner && (
        <div className="z-10 mt-0.5 whitespace-nowrap rounded bg-black/60 px-1.5 text-[10px] text-amber-200">
          {description}
        </div>
      )}
    </motion.div>
  );
}
