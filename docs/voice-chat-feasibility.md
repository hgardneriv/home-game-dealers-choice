# Voice chat feasibility assessment (2026-07-30 — investigation only, nothing built)

Question: how feasible is an opt-in live voice channel for human players in a
hosted game — a Discord-style conference call so the table can talk trash during
the game, like a real home game?

## Verdict: feasible, with three honest tiers

Voice between browsers is WebRTC, and at home-game scale (≤ ~8 humans) a full
peer-to-peer audio mesh is well within reach — 6 players is 15 peer connections,
~5 Opus streams up/down per client at ~30–40 kbps each, fine on wifi and OK on
LTE. No SFU (media server) is needed at this scale. The feasibility question is
not the audio; it's two pieces of infrastructure the app deliberately doesn't
have:

1. **Signaling.** WebRTC peers must exchange SDP offers/answers and ICE
   candidates before audio flows. The app is fully serverless: no WebSocket
   server, no pub/sub — every client independently polls Redis at 2 Hz via SSE
   (`src/app/api/games/[id]/stream/route.ts`). Signaling can ride this pattern
   (separate short-TTL Redis keys + a second SSE channel, ~0.5–1 s per handshake
   hop — fine, handshakes are one-time), but it must NOT go through `GameState`:
   every write there is a CAS version bump that fans a full state frame to every
   client, and the Redis free plan is shared with the old app. Vercel now also
   supports WebSockets on Fluid Compute, which would be a cleaner dedicated
   signaling channel.
2. **TURN relay.** STUN (free, public) gets ~80–90% of peer pairs connected;
   the rest (symmetric NATs, some carrier-grade mobile NAT) need a TURN relay —
   a third-party service (Cloudflare, metered.ca, Twilio; free tiers exist).
   Without it, voice silently fails for specific player *pairs*, which reads as
   "voice is broken."

## The three tiers

- **Tier 0 — link out (~1 hour).** Host pastes a Discord/FaceTime link at game
  creation; it renders as a "🔊 Join the call" button in the room. No WebRTC, no
  new infra, works today. Honestly captures ~90% of the social value.
- **Tier 1 — embedded provider (~1 day).** Drop a prebuilt call widget (Daily
  prebuilt, Jitsi iframe, LiveKit components) into `GameRoom`, room name =
  gameId. Voice lives inside the game page; provider handles signaling, TURN,
  mobile quirks. Free tiers comfortably cover a weekly home game. Trade-off:
  third-party dependency and their UI chrome inside yours.
- **Tier 2 — native WebRTC mesh (~3–5 days + ongoing ops).** Fully in-product:
  mic toggle in the `GameRoom` header (mirrors `InviteButton`), per-seat
  speaking indicator badges in `Seat.tsx` next to the existing 💤/🤖 badges,
  hidden `<audio>` elements in `GameRoom`, Redis+SSE (or WebSocket) signaling
  route reusing the `hg_{gameId}` cookie auth, and a TURN service. Bots are
  naturally excluded. Best product feel, but takes on real operational surface
  (TURN account, NAT edge cases, reconnect handling across the 240 s SSE stream
  lifetime) for a friends-scale app.

## What the codebase already gives us (if built)

- **Auth for a signaling route is free**: `playerIdFromRequest` one-liner
  (`src/server/identity.ts`).
- **iOS gesture unlock already exists**: `unlockAudio()` + shared `AudioContext`
  in `GameRoom.tsx` — the exact pattern `getUserMedia` needs. Keep remote
  streams on plain `<audio>` elements (not WebAudio) to respect the iOS
  GPU/audio constraints.
- **Presence badge template exists**: the `imBack` path (client POST → `Player`
  flag → `ClientPlayer` in `redact.ts` → badge in `Seat.tsx`) is exactly how an
  `onVoice` flag would flow. Toggles are rare/idempotent — never heartbeat
  through game state.

## Real caveats regardless of tier

- **Phones backgrounding**: iOS Safari suspends the tab (and mic) when a player
  switches apps or locks the screen mid-hand. Unavoidable in-browser; native
  apps (Discord) handle this better — a point in favor of Tier 0.
- **P2P mesh exposes player IPs to each other** (fine among friends, worth
  knowing).
- **Speaking indicators** need per-stream level analysis — keep it to a cheap
  `AnalyserNode` poll or skip it; don't add per-frame work to the animated
  table.

## Recommendation

If/when voice is wanted: **Tier 1 (embedded provider)** is the sweet spot —
real in-game voice in about a day with zero ops burden. Tier 0 is the pragmatic
"tonight's game" answer. Tier 2 only makes sense if the fun is in building it.

## Verification (if a build proceeds)

Two browsers (one Chrome, one iOS Safari on LTE, not same wifi) in a hosted
game: opt in on both, confirm audio both ways, confirm mute, confirm a player
who never opts in sees no permission prompt, and confirm game SSE frames don't
grow.
