@AGENTS.md

# Home Game Poker — session handoff & architecture notes

Link-based multiplayer Texas Hold'em (PokerNow-style) built July 2026. Fully working and **deployed to production**. This file is the context a future session needs to continue the work.

## Deployment (live)

- **Production:** https://home-game-poker-kappa.vercel.app
- Vercel project `home-game-poker` under team `hgardnerivs-projects`; deploy with `vercel deploy --prod` (CLI-based; deploys are NOT git-triggered).
- Storage: Upstash Redis via Vercel Marketplace, resource `home-game-poker-redis`, **free plan** — upgrade to pay-as-you-go if game nights hit command limits (each SSE-connected client polls the version key every 500ms server-side).
- Env vars (values live in Vercel, never in the repo): `SESSION_SECRET` (prod + preview), `KV_REST_API_URL`, `KV_REST_API_TOKEN`. ⚠️ The Marketplace names Redis vars `KV_REST_API_*`, NOT `UPSTASH_REDIS_REST_*` — `src/server/kv.ts` accepts both.
- Preview deployments sit behind Vercel Authentication (not shareable with friends) — share/test on production.
- Local dev without Redis env uses an in-memory KV automatically (single-process only). `vercel env pull .env.local` for real Redis locally.

## Architecture (all decisions were deliberate — see rationale inline in code)

- **Pure engine** (`src/engine/`): deterministic state machine, zero deps, no `Date.now()`/RNG inside — both injected via `ctx = { now, randInt }`. `applyAction(state, action, ctx)` never mutates its input (structuredClone at entry). `getLegalActions` is shared by server validation AND the client ActionBar so they can never disagree. Hand-rolled 7-card evaluator (best-of-21, packed integer scores).
  - Rules covered & tested: heads-up blinds (button = SB, acts first preflop / last postflop), BB option, min-raise = last full raise size, short all-ins don't reopen betting (cumulative shorts do), layered side pots + uncalled-bet refunds, dead-button rotation (`computePositions` in `seating.ts`), blind-arc exclusion for mid-orbit joiners, showdown order + auto-muck, odd chip to first winner left of button.
- **Bots** (`src/engine/bot.ts`): a bot is a Player with `isBot` + personality `{tightness, aggression, bluffFreq}`. Decides from a narrow `BotView` built from redacted data (can't cheat by construction). Defense curve: `required = min(0.72, 0.18 + potOdds*0.45 + tightness*0.1)`; flush/open-ended draw awareness on flop/turn; probabilistic bluff-catching. Tuning these constants is how you make bots looser/tighter.
- **Storage** (`src/server/kv.ts`, `store.ts`): two Redis keys per game (`g:{id}:v` version, `g:{id}:s` state JSON, 24h TTL). ALL mutations flow through `withGame()` → read → sweep → user action → Lua-CAS write → retry (max 4). Version is monotonic; clients drop stale frames.
- **Serverless timing** (`src/server/sweep.ts`): no background processes. Every state read runs the sweep: expired turn → timeout action (time bank once, then auto check/fold + away); bot's `botActAt` due → `decideForBot`; `nextHandAt` due → next hand. SSE ticks make these fire within ~1s. If no client is connected the game freezes until someone returns — intentional.
- **Realtime**: SSE (`stream/route.ts`) — polls the version key every 500ms, pushes full redacted state with `id:<version>`, heartbeat 15s, self-closes at 240s (EventSource auto-reconnects with Last-Event-ID). WebSockets were deliberately rejected (no Upstash pub/sub over REST → WS would still poll). Client (`useGame.ts`): SSE + 10s safety poll + visibilitychange resync. ⚠️ A stream opened before the player joined is authenticated as nobody — after `join()` the client MUST reconnect the stream, and `applyState` refuses to let an anonymous frame downgrade an identified session (this fixed a nasty "guest bounced to join screen" bug).
- **Identity** (`src/server/identity.ts`): per-game httpOnly cookie `hg_{gameId}` = `{playerId}.{HMAC-SHA256(playerId:gameId, SESSION_SECRET)}`. No accounts; refresh restores the seat.
- **Redaction** (`src/server/redact.ts`): `ClientGameState` is a DISTINCT type from `GameState` so the compiler prevents ever serializing the deck / others' hole cards. Keep it that way.
- **UI**: `GameRoom` → mode switch (join / waiting / left-kicked farewell / game-over standings / table). Table seats absolutely positioned from two coordinate maps (portrait/landscape via `useOrientation`), view rotated so YOUR seat is bottom-center. Motion animations; events ring buffer (cap 100) drives history + toasts. Numeric form fields keep raw strings while editing (mobile clear-field bug) — parse on submit.

## Testing

`npm test` — 70+ Vitest tests. The engine suite is the correctness spine (every rule edge above has a scenario test), plus **fuzz**: 150 seeded complete games mixing bot and random-legal actors with invariants (chip conservation, no negative stacks, termination) checked after every action. `Table` harness in `src/engine/test-utils.ts` (zeroRand → deterministic button at seat 0; `rig()` to plant hole/board cards). Server CAS concurrency tests use `MemoryKV`. When touching engine logic, add a scenario test first; the fuzz will catch conservation breaks.

Browser-automation caveat: an occluded Chrome window gets no rAF, so Motion animations freeze at initial values in screenshots — that's the tool environment, not a bug.

## Conventions & gotchas

- Bet/raise amounts are **"raise TO" street totals**, not increments.
- `globalThis.__gameKV` singleton survives dev HMR — after editing `kv.ts`, restart `next dev`.
- `next.config.ts` pins `turbopack.root` (stray lockfile in $HOME confuses inference).
- All API routes are `dynamic = 'force-dynamic'`, Node runtime (never edge). Stream route sets `maxDuration = 300`.
- No git-triggered deploys; run tests before `vercel deploy --prod`.
- `.claude/settings.local.json` is gitignored (personal permissions). `.env.local` / `.vercel` never committed.

## Roadmap (user-confirmed direction)

1. **Public lobby with matchmaking** — architecture is ready: rooms are self-contained under `g:{id}:*`; a lobby is an index (e.g. `lobby:open` sorted set) + a browse page + a create-path flag. Bots need zero changes. The game-over screen's "Play again" is where "Back to lobby" will live.
2. Possible smaller items: host rebuys/top-ups mid-game, escalating blinds option, run-it-twice, four-color deck, sounds toggle, bot difficulty setting.
3. User play-tests with real friends and reports tweaks — expect rapid small iterations (bot tuning constants, UX affordances).
