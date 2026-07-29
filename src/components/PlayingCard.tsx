'use client';

import { motion } from 'motion/react';

/**
 * Crisp SVG playing card — no image assets, sharp at any DPI.
 * Face-up cards flip in when they first appear.
 */

const SUIT_PATH: Record<string, string> = {
  // 24x24 suit glyphs, centered.
  s: 'M12 2C9.5 6.5 4 9.5 4 13.5c0 2.5 2 4.2 4.2 4.2 1.1 0 2.1-.4 2.8-1.1-.3 1.9-1.1 3.4-2.5 4.4v1h7v-1c-1.4-1-2.2-2.5-2.5-4.4.7.7 1.7 1.1 2.8 1.1 2.2 0 4.2-1.7 4.2-4.2C20 9.5 14.5 6.5 12 2z',
  h: 'M12 21C6 15.5 2 12 2 8.2 2 5.3 4.2 3 7 3c1.9 0 3.8 1 5 2.7C13.2 4 15.1 3 17 3c2.8 0 5 2.3 5 5.2 0 3.8-4 7.3-10 12.8z',
  d: 'M12 2l6.5 10L12 22 5.5 12 12 2z',
  c: 'M12 2a4.4 4.4 0 0 0-4.4 4.4c0 .6.1 1.2.4 1.7A4.4 4.4 0 1 0 10 15.7c-.2 2-1 3.5-2.4 4.5v1h8.8v-1c-1.4-1-2.2-2.5-2.4-4.5a4.4 4.4 0 1 0 2-7.6c.3-.5.4-1.1.4-1.7A4.4 4.4 0 0 0 12 2z',
};

const SIZES = {
  sm: { w: 28, h: 40 },
  md: { w: 40, h: 58 },
  lg: { w: 52, h: 74 },
};

export function PlayingCard({
  card,
  size = 'md',
  dealt = false,
}: {
  /** e.g. 'As'; undefined renders a face-down card. */
  card?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Animate in (deal/flip) when the card first mounts. */
  dealt?: boolean;
}) {
  const { w, h } = SIZES[size];

  if (!card) {
    return (
      <div
        style={{ width: w, height: h }}
        className="rounded-[4px] border border-white/25 shadow-md"
        aria-label="face-down card"
      >
        <div
          className="h-full w-full rounded-[3px]"
          style={{
            background:
              'repeating-linear-gradient(45deg, #1e3a8a 0 3px, #172c69 3px 6px)',
            boxShadow: 'inset 0 0 0 2px rgba(255,255,255,0.18)',
          }}
        />
      </div>
    );
  }

  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';
  const color = red ? '#dc2626' : '#111827';

  return (
    <motion.div
      initial={dealt ? { scaleX: 0.1, y: -10, opacity: 0 } : false}
      animate={{ scaleX: 1, y: 0, opacity: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      style={{ width: w, height: h }}
      aria-label={card}
    >
      <svg
        viewBox="0 0 40 58"
        width={w}
        height={h}
        className="rounded-[4px] shadow-md"
        style={{ display: 'block' }}
      >
        <rect x="0" y="0" width="40" height="58" rx="4" fill="#ffffff" stroke="#d4d4d8" />
        <text
          x="5"
          y="15"
          fontSize={rank === '10' ? 11 : 13}
          fontWeight="800"
          fontFamily="system-ui, sans-serif"
          fill={color}
        >
          {rank}
        </text>
        <g transform="translate(3.5, 18) scale(0.5)">
          <path d={SUIT_PATH[suit]} fill={color} />
        </g>
        <g transform="translate(17, 26) scale(0.85)">
          <path d={SUIT_PATH[suit]} fill={color} opacity="0.92" />
        </g>
      </svg>
    </motion.div>
  );
}
