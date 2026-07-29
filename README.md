# 🃏 Home Game Poker

Texas Hold'em with friends — share a link, take a seat.

**Live:** https://home-game-poker-kappa.vercel.app

A polished, mobile-first multiplayer poker table with a hidden automated dealer. No accounts: the host creates a table, shares the link (native share sheet on phones), and approves who sits down. Everyone buys in with $1 coins, blinds post automatically, and a freshly CSPRNG-shuffled 52-card deck is dealt every hand. Play solo against 5 computer players with one click, or host a friends game with 0–5 bots filling the empty seats.

## Features

- **6-seat no-limit Texas Hold'em** with a correct rules engine: heads-up blinds, big-blind option, min-raise and short all-in rules, layered side pots with refunds, dead-button rotation, showdown order with auto-muck, odd-chip splits
- **NPC bots** with personalities (tightness / aggression / bluff frequency) that decide from a redacted view — structurally unable to cheat — and that defend properly against relentless betting
- **Invite-link multiplayer**: name-only entry, host approval of seats, per-game signed httpOnly cookie identity — a refresh or dropped connection restores your seat
- **Real-time** via Server-Sent Events with reconnect and mobile-background resync; sub-second updates
- **Turn timers** (20s + 10s time bank, host-configurable) with auto check/fold, away state, and "I'm back"
- **Host controls**: approve/deny seats, pause, kick, add/remove bots, end game (with final standings screen)
- **Guests can leave any time** — big Leave button; everyone else is notified
- Responsive: portrait-first phone layout and desktop oval table; animated cards, chips, pot, and winner banners

## Stack

Next.js (App Router, TypeScript, Tailwind v4) · Upstash Redis via Vercel Marketplace (atomic compare-and-set versioned state) · Motion (Framer Motion) · Vitest · deployed on Vercel (Node runtime / Fluid Compute).

## Development

```bash
npm install
npm run dev        # http://localhost:3000 — uses in-memory storage if no Redis env
npm test           # engine + server suite (incl. 150-game fuzz with chip-conservation invariants)
npm run lint
npx tsc --noEmit
```

For real-Redis local dev: `vercel env pull .env.local` (project must be linked with `vercel link`).

Required env in production: `SESSION_SECRET`, plus `KV_REST_API_URL` / `KV_REST_API_TOKEN` (auto-provisioned by the Upstash Marketplace integration).

## Deploy

```bash
vercel deploy --prod
```

See `CLAUDE.md` for the architecture deep-dive and contributor notes.
