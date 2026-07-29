@AGENTS.md

# Home Game — Dealer's Choice: session handoff & architecture notes

Fork of `home-game-poker` (July 2026) converting the single-game Texas Hold'em app
into ante-based **dealer's choice**: the dealer picks the game each hand from a
host-enabled list. The approved build plan lives in the session plan file and as a
claude.ai artifact; milestones: **M1** ante conversion + variant framework (DONE),
**M2** dealer-pick flow, **M3** five-card draw, then stud/guts/baseball/in-between
as parallel variant modules.

## Deployment

- **Not deployed yet.** The parent repo's Vercel project belongs to the old app.
  After M2: create a new Vercel project + Upstash Redis resource + fresh
  `SESSION_SECRET`, then `vercel deploy --prod` (deploys are CLI-based, never
  git-triggered). Env names: `KV_REST_API_URL` / `KV_REST_API_TOKEN` (Marketplace
  naming — `src/server/kv.ts` accepts both those and `UPSTASH_REDIS_REST_*`).
- Local dev without Redis env uses an in-memory KV automatically (single-process).

## Architecture (decisions deliberate; rationale inline in code)

- **Pure engine** (`src/engine/`): deterministic state machine, zero deps, no
  `Date.now()`/RNG inside — both injected via `ctx = { now, randInt }`.
  `applyAction(state, action, ctx)` never mutates its input (structuredClone at
  entry). `getLegalActions` is shared by server validation AND the client
  ActionBar so they can never disagree — it now returns a discriminated union
  `BettingLegal | ExchangeLegal` on `kind`.
- **Ante rules (replaced blinds July 2026, user-confirmed)**: every dealt-in
  player antes `min(config.ante, stack)` into `totalCommitted` only (side pots
  come out right via `buildPots` for free); every street opens check-or-bet with
  `currentBet 0`, min open = `config.minBet` (default 2× ante, host knob); first
  to act = left of button on EVERY street (no heads-up special case: non-button
  first, button last). Button = `computeButton` in `seating.ts`: first hand
  random eligible seat, then `nextEligibleSeat` — always an eligible player.
  Dead button, dead SB, blind arc, `hasPlayed`, `prevBbSeat` all deleted with
  the blinds.
- **Variant framework** (`src/engine/variants/`): each game is a pure module
  implementing `GameVariant` (`variants/types.ts`): metadata (name/marquee/
  layoutHint/minPlayers/fitsPlayers), `deal`, `nextPhase` (returns
  `PhasePlan = {kind: 'betting'|'exchange', street} | {kind:'showdown'}`),
  `score`/`describeScore`, optional `exchange` (draw/declare/flip moves via
  `VariantMoveInput`), optional `settle` (pot-matching for guts/in-between,
  capped at table stakes), and `bot.decideBet`/`decideExchange`. State stores
  only `hand.variant` (JSON-safe); the engine resolves modules via
  `variants/registry.ts` (`IMPLEMENTED_VARIANTS`, `getVariant`,
  `_registerVariantForTest` for stub variants in tests). `engine.ts`'s
  `advance()` is a loop: round closes → `variant.nextPhase` → open round; a
  betting phase with ≤1 actor auto-skips (that IS the all-in runout); exchange
  phases walk `active()` (all-in players still draw). Hold'em lives in
  `variants/holdem.ts` (~60 lines) — proof of how small a variant is.
- **Cards**: `hand.playerCards[id] = { cards: Card[], faceUp: boolean[] }` —
  per-card visibility supports stud up-cards and no-peek flips already.
  `hand.discards` (secret) for draw games. `hand.vstate` is variant-private
  JSON-safe scratch.
- **Config** (`normalizeConfig` in engine.ts): `ante` (1..stack), `minBet`
  (ante..stack, defaults 2×ante when omitted), `enabledVariants` (filtered to
  registry, deduped, never empty — falls back `['holdem']`). Quick play forces
  `topUps: 0` and all implemented variants at the create route.
- **Bots** (`src/engine/bot.ts`): a bot decides from a narrow `BotView` built
  from redacted data (can't cheat by construction; now includes `publicCards`
  for future stud). The hold'em betting brain (`botDecide`, Chen preflop +
  postflop eval + draw awareness) is wired via `holdem.bot.decideBet`;
  `decideForBot` dispatches through the registry and legality-clamps. Defense
  curve: `required = min(0.72, 0.18 + potOdds*0.45 + tightness*0.1)`.
- **Top-ups**: unchanged from parent except the floor: amounts below `minBet`
  are never offered (`topup.ts`). Quick play forces `topUps: 0`.
- **Storage** (`src/server/kv.ts`, `store.ts`): two Redis keys per game
  (version + state JSON, 24h TTL). ALL mutations flow through `withGame()` →
  read → sweep → user action → Lua-CAS write → retry (max 4).
- **Serverless timing** (`src/server/sweep.ts`): no background processes; every
  read runs the sweep: busted-bot rebuy → bot turn (`botActAt`) → timeout
  (time bank once, then auto check/fold — or the variant's `autoMove` on
  exchange rounds — then away) → `nextHandAt` → next hand. M2 adds the
  choosing-phase checks (bot dealer pick, `chooseTimeout`) BEFORE nextHand.
- **Realtime**: SSE polling the version key every 500ms; heartbeat 15s;
  self-closes 240s. After `join()` the client MUST reconnect the stream
  (anonymous-frame downgrade guard in `useGame.applyState`).
- **Identity** (`src/server/identity.ts`): per-game httpOnly cookie
  `hg_{gameId}` = `{playerId}.{HMAC-SHA256(playerId:gameId, SESSION_SECRET)}`.
- **Redaction** (`src/server/redact.ts`): `ClientGameState` is a DISTINCT type
  from `GameState` so the compiler prevents serializing `deck`, `discards`,
  `vstate`, or face-down `playerCards`. Clients get `myCards: Card[]`,
  `publicCards` (face-up only), `cardCounts` (for rendering backs),
  `choosing`. Keep the type separation.
- **UI**: `GameRoom` mode switch → `Table` (marquee text = variant's `marquee`,
  "DEALER'S CHOICE" between games; board slots only for `layoutHint: 'board'`)
  → `Seat` (renders `cardCounts` backs + `publicCards` face-up + `myCards`/
  `revealed` arrays) → `ActionBar` (renders purely from `legalActions`;
  exchange-round UI arrives with M3; M2 adds the dealer's pick branch).
  `CreateGame` has Ante/Min-bet fields + enabled-games checklist (never empty).
- ⚠️ **iOS GPU constraint** (inherited, still binding): NEVER add
  `backdrop-filter`/CSS `filter` to animated or frequently-repainting table
  elements; animate transforms, not layout. One shared `AudioContext` unlocked
  on first `pointerdown` — never per-event contexts.
- **Dealer's-choice actions**: `chooseGame`/`chooseTimeout` exist in the Action
  union but fail `bad-phase` until M2 wires the `choosing` GamePhase
  (`GameState.choosing: ChoosingState | null` is already in the state and
  redaction). Auto-pick policy (user-confirmed): repeat previous variant, else
  first enabled; absent human dealer goes away like a betting timeout.

## Testing

`npm test` — Vitest. The engine suite is the correctness spine (ante posting,
short-ante side pots, first-to-act, min-raise/short-all-in reopening, button
rotation, top-up schedule), plus **fuzz**: 150 seeded complete games mixing bot
and random-legal actors with invariants (chip conservation vs Σ totalBuyIn, no
negative stacks, termination) checked after every action. `Table` harness in
`src/engine/test-utils.ts` (zeroRand → first-hand button at lowest eligible
seat; `rig(playerCards, board)` plants cards; `legalFor` returns narrowed
`BettingLegal`). Server CAS tests use `MemoryKV` via `globalThis.__gameKV`.
When touching engine logic, add a scenario test first; fuzz catches
conservation breaks. Mutation testing: `npx stryker run` (engine+server,
`bot.ts` excluded) — re-harden after M3; expect a dip until then. Cache-bust
with `rm -rf reports .stryker-tmp` after changing tests.

Browser-automation caveat: an occluded Chrome window gets no rAF, so Motion
animations freeze in screenshots — tool environment, not a bug.

## Conventions & gotchas

- Bet/raise amounts are **"raise TO" street totals**, not increments.
- `globalThis.__gameKV` singleton survives dev HMR — restart `next dev` after
  editing `kv.ts`.
- `next.config.ts` pins `turbopack.root`.
- All API routes `dynamic = 'force-dynamic'`, Node runtime. Stream route
  `maxDuration = 300`.
- No git-triggered deploys; run tests before `vercel deploy --prod`.
- `.claude/settings.local.json` gitignored; `.env.local` / `.vercel` never
  committed.

## Roadmap (user-confirmed)

1. **M2 — dealer-pick flow**: `choosing` phase between hands when >1 variant
   enabled (skip when 1), `chooseGame`/`chooseTimeout` handlers, sweep checks,
   ActionBar pick UI, dealer disc from `choosing.buttonSeat`.
2. **M3 — five-card draw** (`variants/five-draw.ts`): 5 down → bet → discard
   0–3 (user-confirmed, no 4-with-ace) → bet → showdown `evaluate5`; exchange
   UI (tap-to-select + Discard/Stand pat); bot draw policy; then a mutation
   hardening pass over M1–M3.
3. **Variant fan-out** (parallelizable, one agent per module once M2+M3 prove
   the interface): 7-stud (faceUp deals, maybe highest-board first-to-act),
   guts (declare + `settle` + carry-pot & fuzz invariant update), baseball
   (flip turns; needs wild-card evaluator + five-of-a-kind), in-between
   (wager/pass vs pot; `score` unused).
4. Deploy: new Vercel project + Redis + SESSION_SECRET after M2.
