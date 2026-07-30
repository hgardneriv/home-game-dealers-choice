'use client';

import { motion } from 'motion/react';

/**
 * Crisp SVG playing card — no image assets, sharp at any DPI.
 * Face-up cards flip in when they first appear.
 */

export const SUIT_PATH: Record<string, string> = {
  // 24x24 suit glyphs, centered.
  s: 'M12 2C9.5 6.5 4 9.5 4 13.5c0 2.5 2 4.2 4.2 4.2 1.1 0 2.1-.4 2.8-1.1-.3 1.9-1.1 3.4-2.5 4.4v1h7v-1c-1.4-1-2.2-2.5-2.5-4.4.7.7 1.7 1.1 2.8 1.1 2.2 0 4.2-1.7 4.2-4.2C20 9.5 14.5 6.5 12 2z',
  h: 'M12 21C6 15.5 2 12 2 8.2 2 5.3 4.2 3 7 3c1.9 0 3.8 1 5 2.7C13.2 4 15.1 3 17 3c2.8 0 5 2.3 5 5.2 0 3.8-4 7.3-10 12.8z',
  d: 'M12 2l6.5 10L12 22 5.5 12 12 2z',
  c: 'M12 2a4.4 4.4 0 0 0-4.4 4.4c0 .6.1 1.2.4 1.7A4.4 4.4 0 1 0 10 15.7c-.2 2-1 3.5-2.4 4.5v1h8.8v-1c-1.4-1-2.2-2.5-2.4-4.5a4.4 4.4 0 1 0 2-7.6c.3-.5.4-1.1.4-1.7A4.4 4.4 0 0 0 12 2z',
};

/**
 * Responsive widths (height follows the 20:29 card ratio) — noticeably
 * larger on desktop, a step up from the old fixed sizes on mobile too.
 */
const SIZE_CLASSES = {
  sm: 'w-8 sm:w-10',
  md: 'w-12 sm:w-14',
  lg: 'w-14 sm:w-[72px]',
};

export function PlayingCard({
  card,
  size = 'md',
  dealt = false,
  wild = false,
  facedown = false,
}: {
  /** e.g. 'As'; undefined renders a face-down card. */
  card?: string;
  size?: 'sm' | 'md' | 'lg';
  /** Animate in (deal/flip) when the card first mounts. */
  dealt?: boolean;
  /** Gold WILD band (baseball 3s/9s). */
  wild?: boolean;
  /** Your own hole card others can't see (stud) — shaded card-back blue. */
  facedown?: boolean;
}) {
  const sizing = `${SIZE_CLASSES[size]} aspect-[20/29]`;

  if (!card) {
    return (
      <div className={sizing} aria-label="face-down card">
        <svg
          viewBox="0 0 40 58"
          width="100%"
          height="100%"
          className="block rounded-[4px] shadow-md"
        >
          <defs>
            <linearGradient id="hgCardBack" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#1e3a8a" />
              <stop offset="1" stopColor="#142457" />
            </linearGradient>
            <pattern
              id="hgLattice"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <path d="M0 0H6" stroke="rgba(255,255,255,0.13)" strokeWidth="1" />
            </pattern>
          </defs>
          <rect width="40" height="58" rx="4" fill="url(#hgCardBack)" stroke="#0e1c45" />
          <rect
            x="2.5"
            y="2.5"
            width="35"
            height="53"
            rx="2.5"
            fill="url(#hgLattice)"
            stroke="rgba(251,191,36,0.45)"
            strokeWidth="0.8"
          />
          {/* Center medallion echoes the felt's gold-on-dark styling. */}
          <circle cx="20" cy="29" r="8.5" fill="#142457" stroke="rgba(251,191,36,0.5)" strokeWidth="0.8" />
          <g transform="translate(14.5, 23.2) scale(0.46)">
            <path d={SUIT_PATH.s} fill="rgba(251,191,36,0.8)" />
          </g>
        </svg>
      </div>
    );
  }

  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = card[1];
  const red = suit === 'h' || suit === 'd';
  const color = red ? '#d92638' : '#101828';
  const indexSize = rank === '10' ? 9.5 : 11;

  return (
    <motion.div
      initial={dealt ? { scaleX: 0.1, y: -10, opacity: 0 } : false}
      animate={{ scaleX: 1, y: 0, opacity: 1 }}
      transition={{ duration: 0.25, ease: 'easeOut' }}
      className={sizing}
      aria-label={card}
    >
      <svg
        viewBox="0 0 40 58"
        width="100%"
        height="100%"
        className="block rounded-[4px] shadow-lg"
      >
        <defs>
          <linearGradient id="hgCardFace" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#f2eee4" />
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="40" height="58" rx="4" fill="url(#hgCardFace)" stroke="#cbc5b7" />
        <rect x="1.6" y="1.6" width="36.8" height="54.8" rx="3" fill="none" stroke="rgba(0,0,0,0.06)" />

        {/* Oversized ghost pip — a subtle watermark like the felt's. */}
        <g transform="translate(7.4, 16.4) scale(1.05)">
          <path d={SUIT_PATH[suit]} fill={color} opacity="0.08" />
        </g>

        {/* Corner index, top-left… */}
        <text
          x="4"
          y="12.5"
          fontSize={indexSize}
          fontWeight="800"
          fontFamily="system-ui, sans-serif"
          fill={color}
        >
          {rank}
        </text>
        <g transform="translate(4, 14.5) scale(0.34)">
          <path d={SUIT_PATH[suit]} fill={color} />
        </g>

        {/* …and mirrored bottom-right, like a real deck. */}
        <g transform="rotate(180, 20, 29)">
          <text
            x="4"
            y="12.5"
            fontSize={indexSize}
            fontWeight="800"
            fontFamily="system-ui, sans-serif"
            fill={color}
          >
            {rank}
          </text>
          <g transform="translate(4, 14.5) scale(0.34)">
            <path d={SUIT_PATH[suit]} fill={color} />
          </g>
        </g>

        {/* Main center pip. */}
        <g transform="translate(11.4, 20.4) scale(0.72)">
          <path d={SUIT_PATH[suit]} fill={color} opacity="0.95" />
        </g>

        {/* Face-down (to the table) shading: card-back blue wash + tag. */}
        {facedown && (
          <g>
            <rect width="40" height="58" rx="4" fill="#1e3a8a" opacity="0.32" />
            <rect x="7" y="45" width="26" height="8" rx="4" fill="#142457" opacity="0.9" />
            <text
              x="20"
              y="51"
              fontSize="5.5"
              fontWeight="700"
              fontFamily="system-ui, sans-serif"
              textAnchor="middle"
              fill="#bfdbfe"
              letterSpacing="0.5"
            >
              DOWN
            </text>
          </g>
        )}

        {/* Wild marker: gold band across the middle. */}
        {wild && (
          <g>
            <rect x="3" y="24" width="34" height="10" rx="2" fill="#b45309" stroke="#78350f" strokeWidth="0.7" />
            <text
              x="20"
              y="31.5"
              fontSize="7"
              fontWeight="800"
              fontFamily="system-ui, sans-serif"
              textAnchor="middle"
              fill="#fef3c7"
              letterSpacing="1.2"
            >
              WILD
            </text>
          </g>
        )}
      </svg>
    </motion.div>
  );
}
