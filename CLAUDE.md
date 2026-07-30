@AGENTS.md

# Home Game — Dealer's Choice: session handoff & architecture notes

Fork of `home-game-poker` (July 2026) converting the single-game Texas Hold'em app
into ante-based **dealer's choice**: the dealer picks the game each hand from a
host-enabled list. ALL SIX GAMES SHIPPED (July 2026): hold'em, five-card draw,
seven-card stud, three-card guts, baseball (no-peek, wild 3s/9s), in-between —
each a pure module in `src/engine/variants/` built against the shared plumbing
(carry pot, communal pot, settle/resolve hooks, turnContinues multi-step turns,
noPeek redaction). Suite: 455+ tests incl. an all-variant fuzz that plays random
mixed-game nights and a host-ends-long-games path. Browser-verified per game.

## Deployment (live)

- **Production:** https://home-game-dealers-choice.vercel.app — Vercel project
  `home-game-dealers-choice`, team `hgardnerivs-projects`; deploy with
  `vercel deploy --prod` (CLI-based, never git-triggered; run tests first).
- Env (values in Vercel, never the repo): `SESSION_SECRET` (fresh per project),
  `KV_REST_API_URL` / `KV_REST_API_TOKEN`. ⚠️ Values must be UNQUOTED — a
  quoted URL pasted from an env file produces "invalid URL" 500s at runtime.
- **Redis is SHARED with the old `home-game-poker` app** (same Upstash
  `home-game-poker-redis` resource, free plan). Fine for game nights; if
  command limits bite, provision a dedicated Marketplace resource for this
  project and swap the two env vars. `src/server/kv.ts` accepts both
  `KV_REST_API_*` and `UPSTASH_REDIS_REST_*` names.
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
**E2E**: `npm run test:e2e:ci` — Playwright plays a real in-between night vs
bots (reuses dev server on :3000). `test:e2e` runs headed; the user has SEEN
it once and does not want headed runs repeated — default to :ci. E2E clicks
must be best-effort with short timeouts (SSE re-renders every 500ms; turns
expire server-side), and `locator.isEnabled()` WAITS on absent elements —
gate it behind `isVisible()`.
When touching engine logic, add a scenario test first; fuzz catches
conservation breaks. Mutation testing: `npx stryker run` (engine+server,
`bot.ts` excluded) — **94.5% kill rate** (July 2026 hardening pass; 618-test
suite). The ~200 remaining survivors are documented: variant bot-policy tuning
constants (same category as the excluded bot.ts) and proven-equivalent mutants
(one-line proofs in the `*.mutants.test.ts` headers and hardening-pass agent
reports). Cache-bust with `rm -rf reports .stryker-tmp` after changing tests.

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

## Roadmap (user-confirmed) — NEXT SESSION STARTS HERE

1. **Per-game UX pass SHIPPED (2026-07-29, deployed).** In-between: cards in
   slots 1+3, third card lands in the middle for a 4s all-table reveal
   (`GameVariant.resultReveal` + `shows` predicate; bots held via stampTurn;
   wager bar gated), win/lose banners, DOUBLE BURN marquee, one-tap presets
   (Pass/$min/¼/½/Pot), and the house rule **a pass burns NO card**. Stud:
   own down cards shaded via `ClientHand.myFaceUp`. Wilds badged via
   `GameVariant.wildRanks` (baseball 3/9). Live made-hand labels under every
   seat (`src/engine/hand-label.ts` — opponents from face-up cards only).
   Last-used name prefills create/join (localStorage). Collect the NEXT round
   of play-testing feedback before inventing more.
2. Bot tuning from play-testing (personality constants in `bot.ts` +
   per-variant strength/policy functions — all deliberately Stryker-excluded
   tuning knobs). Note: in-between bots still bet by spread only.
3. House-rule toggles parked for later: baseball pay-for-3 / extra-card-on-4,
   draw 4-with-an-ace, guts secret simultaneous declares, dedicated Redis
   resource if game nights hit the shared free-plan limits.

Session mechanics that worked well (keep): milestone commits with rich
messages; parallel background agents for disjoint file sets (new-files-only
rule avoids conflicts; `_registerVariantForTest` lets variant tests run
unregistered); browser smoke via single-variant hosted games; the build plan
lives as a claude.ai artifact the user wants kept current.
