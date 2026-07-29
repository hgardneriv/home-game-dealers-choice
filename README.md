# 🃏 Home Game — Dealer's Choice

Poker night the way home games actually work: **the dealer calls the game.**

A mobile-first multiplayer poker table with a hidden automated dealer, forked from
[home-game-poker](https://github.com/hgardneriv/home-game-poker). No accounts: the
host creates a table, shares the link (native share sheet on phones), and approves
who sits down. Everyone antes every hand, the deal rotates, and when it's your deal
you pick the game from the table's enabled list. Play solo against 5 computer
players with one click, or host a friends game with 0–5 bots filling the empty
seats.

## The games

| Game | Status |
| --- | --- |
| Texas Hold'em (ante-based) | ✅ Playable |
| Dealer picks the game each hand | 🔨 In progress (M2) |
| 5-card draw | 🔜 Next (M3) |
| 7-card stud | Planned |
| 3-card guts | Planned |
| 7-card no-peek (baseball) | Planned |
| In-between (acey-deucey) | Planned |

Until more than one game is enabled, hands deal straight into the single enabled
variant with no picking step — a classic single-game night.

## House rules

- **Antes, not blinds.** Every dealt-in player posts the ante at the start of each
  hand (host-set, default $1). No small/big blind anywhere.
- **Check-or-bet opening.** First to act is left of the dealer on every street;
  betting is no-limit with a host-set minimum bet (default 2× ante).
- **The deal rotates** one seat per hand, skipping busted/empty seats. New joiners
  are dealt into the very next hand.
- **Table stakes.** You can never lose more than your stack — including in the
  future pot-matching games (guts, in-between).
- **Top-ups.** Busted players can re-buy on a decaying schedule (host-configurable;
  disabled in quick play).

## Features

- **6-seat table** with a correct rules engine: min-raise and short all-in rules,
  layered side pots with refunds, showdown order with auto-muck, odd-chip splits,
  ante-broke players automatically all-in
- **Plug-in game variants**: each game is a pure module (deal, phase progression,
  scoring, bot policy) behind one interface — new games can't touch the core
- **NPC bots** with personalities (tightness / aggression / bluff frequency) that
  decide from a redacted view — structurally unable to cheat
- **Invite-link multiplayer**: name-only entry, host approval of seats, per-game
  signed httpOnly cookie identity — a refresh or dropped connection restores your seat
- **Real-time** via Server-Sent Events with reconnect and mobile-background resync
- **Turn timers** (20s + 10s time bank, host-configurable) with auto check/fold,
  away state, and "I'm back"
- **Host controls**: approve/deny seats, choose enabled games, pause, kick,
  add/remove bots, end game (with final standings screen)
- Responsive: portrait-first phone layout and desktop oval table; animated cards,
  chips, pot, and winner banners

## Stack

Next.js (App Router, TypeScript, Tailwind v4) · Upstash Redis (atomic
compare-and-set versioned state) · Motion (Framer Motion) · Vitest · Vercel
(Node runtime / Fluid Compute).

## Development

```bash
npm install
npm run dev        # http://localhost:3000 — uses in-memory storage if no Redis env
npm test           # engine + server suite (incl. 150-game fuzz with chip-conservation invariants)
npm run lint
npx tsc --noEmit
```

For real-Redis local dev: `vercel env pull .env.local` (project must be linked with
`vercel link`).

Required env in production: `SESSION_SECRET`, plus `KV_REST_API_URL` /
`KV_REST_API_TOKEN` (auto-provisioned by the Upstash Marketplace integration).

## Deploy

Not yet deployed — a new Vercel project + Redis resource lands once the dealer's
choice flow (M2) is in. Then:

```bash
vercel deploy --prod
```

See `CLAUDE.md` for the architecture deep-dive and contributor notes.
