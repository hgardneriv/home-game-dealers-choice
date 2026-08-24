'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { GameApi } from '@/hooks/useGame';
import { getVariant } from '@/engine/variants/registry';
import { handLabel } from '@/engine/hand-label';
import { PlayingCard } from './PlayingCard';
import { useDrawSelect } from './DrawSelect';

export function Seat({
  game,
  seatIndex,
  playerId,
  visualSlot,
}: {
  game: GameApi;
  seatIndex: number;
  playerId: string | null;
  /** 0 = hero (bottom), 1 = lower-left, 2 = upper-left, 3 = top, 4 = upper-right, 5 = lower-right. */
  visualSlot: number;
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
  const draw = useDrawSelect();
  const pickingDraw = isYou && draw.active && !!showCards;

  // Every seat keeps bet + D beside the hole cards. Right-side seats
  // (2 / 4 o'clock) put chips on the felt side of the cards. The 8 / 4
  // o'clock seats sit at pot height if the stack is centered on the
  // cards, so those chips drop to the card bottoms — next to the hand,
  // under the pot, clear of the nameplate. Hidden while picking discards
  // so the fan has room.
  const chipSide = visualSlot === 4 || visualSlot === 5 ? 'left' : 'right';
  const lowerWing = visualSlot === 1 || visualSlot === 5;
  const seatBet =
    !pickingDraw && hand && !hand.result ? (hand.committed[player.id] ?? 0) : 0;
  const dealerSeat =
    state.phase === 'choosing' ? state.choosing?.buttonSeat : hand?.buttonSeat;
  const seatIsDealer = !pickingDraw && dealerSeat === seatIndex;

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
      className={`relative flex w-max min-w-24 max-w-36 flex-col items-center overflow-visible sm:max-w-48 ${
        isYou && !pickingDraw
          ? 'rounded-xl border border-amber-400/50 bg-black/40 px-2 pb-1 pt-2 shadow-[0_0_0_3px_rgba(0,0,0,0.35),inset_0_0_0_2px_rgba(216,180,92,0.15),0_4px_14px_rgba(0,0,0,0.45)]'
          : isYou && pickingDraw
            ? 'px-2 pb-1 pt-2'
            : ''
      }`}
    >
      {/* Made-hand caption floats on the felt above the cards — lots of
          table room, and it never fights the nameplate. Live (emerald)
          during play; showdown winner (amber) after. */}
      {liveLabel && (
        <HandCaption text={liveLabel} tone="live" yours={isYou} />
      )}
      {description && isWinner && (
        <HandCaption text={description} tone="showdown" yours={isYou} />
      )}

      {/* Cards peeking above the plate. After folding, you (and only you)
          still see your own cards greyed out — to watch what might have been.
          Face-up cards (yours, or anyone's at showdown) sit fully clear of
          the plate so the bottom index isn't cut off; face-down backs tuck. */}
      <div
        className={`relative z-0 flex overflow-visible ${
          pickingDraw
            ? 'w-max shrink-0 -translate-y-2 -space-x-2'
            : Math.max(cardCount, showCards?.length ?? 0) > 2
              ? '-space-x-3'
              : 'gap-0.5'
        } ${showCards ? 'mb-1' : '-mb-2'} ${folded && !pickingDraw ? 'opacity-70 grayscale' : ''} ${
          !(inHand && !folded) && (seatBet > 0 || seatIsDealer)
            ? 'min-h-8 min-w-[3.5rem]'
            : ''
        }`}
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
            {showCards.map((card, i) => {
              const cardEl = (
                <PlayingCard
                  key={`${card}-${i}`}
                  card={card}
                  size={pickingDraw ? 'lg' : isYou ? 'md' : 'sm'}
                  dealt={!pickingDraw}
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
              );
              if (!pickingDraw) return cardEl;
              const on = draw.selected.includes(i);
              return (
                <button
                  key={`${card}-${i}`}
                  type="button"
                  className={`relative rounded-md transition ${
                    on ? '-translate-y-3 ring-2 ring-amber-400' : 'opacity-95'
                  }`}
                  onClick={() => draw.toggle(i)}
                  aria-pressed={on}
                  aria-label={on ? `Keep ${card}` : `Discard ${card}`}
                >
                  {cardEl}
                  {on && (
                    <span className="absolute inset-x-0 -bottom-0.5 text-center text-[9px] font-bold uppercase tracking-wide text-amber-300">
                      swap
                    </span>
                  )}
                </button>
              );
            })}
            {/* No-peek: your flipped cards plus backs for the rest. */}
            {isYou &&
              Array.from({ length: Math.max(0, cardCount - showCards.length) }).map((_, i) => (
                <PlayingCard key={`own-back-${i}`} size="sm" />
              ))}
          </>
        )}
        {(seatBet > 0 || seatIsDealer) && (
          <div
            className={`absolute z-20 flex flex-col items-center gap-1 ${
              lowerWing ? 'bottom-2' : 'top-1/2 -translate-y-1/2'
            } ${
              chipSide === 'left'
                ? 'right-full mr-2'
                : isYou
                  ? 'left-full ml-4'
                  : 'left-full ml-2'
            }`}
          >
            {seatIsDealer && (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-black text-black shadow">
                D
              </span>
            )}
            <AnimatePresence>
              {seatBet > 0 && (
                <motion.div
                  key={`${hand?.street}-${seatBet}`}
                  initial={{ scale: 0.4, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ opacity: 0, scale: 0.8 }}
                  className="whitespace-nowrap"
                >
                  <div className="flex items-center gap-1 rounded-full bg-black/45 py-0.5 pl-0.5 pr-2 shadow">
                    <span className="inline-block h-4 w-4 rounded-full border-2 border-dashed border-white/70 bg-amber-500 shadow-inner" />
                    <span className="text-xs font-bold text-amber-300">{seatBet}</span>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
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
    </motion.div>
  );
}

/** "Pair of Kings" / "Two Pair, Kings and Queens" — sits on the felt. */
function HandCaption({
  text,
  tone,
  yours,
}: {
  text: string;
  tone: 'live' | 'showdown';
  yours: boolean;
}) {
  return (
    <div
      className={`absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md bg-black/70 px-2.5 py-1 font-semibold tracking-wide shadow-lg ${
        yours ? 'text-sm sm:text-base' : 'text-xs sm:text-sm'
      } ${tone === 'live' ? 'text-emerald-300' : 'text-amber-200'}`}
    >
      {text}
    </div>
  );
}
