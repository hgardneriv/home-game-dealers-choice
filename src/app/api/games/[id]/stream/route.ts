import { getKV } from '@/server/kv';
import { withGame } from '@/server/store';
import { playerIdFromRequest } from '@/server/identity';
import { redactForPlayer } from '@/server/redact';
import { dueSweepAction } from '@/server/sweep';
import type { GameState } from '@/engine/types';

export const dynamic = 'force-dynamic';
/** Vercel Fluid Compute allows long-lived functions; we self-close before this. */
export const maxDuration = 300;

const TICK_MS = 500;
const HEARTBEAT_MS = 15_000;
/** Self-close under maxDuration; the browser's EventSource auto-reconnects. */
const STREAM_LIFETIME_MS = 240_000;

/**
 * Server-Sent Events stream of redacted game state. Each tick polls the
 * version counter (cheap); on change — or when a timer/bot action is due —
 * it runs the full sweep pipeline and pushes the new state with the version
 * as the SSE event id, so reconnects resume seamlessly via Last-Event-ID.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id: gameId } = await params;
  const playerId = playerIdFromRequest(req, gameId);
  const kv = getKV();

  const initial = await kv.readVersion(gameId);
  if (initial === 0) return new Response('game not found', { status: 404 });

  let lastSent = Number(req.headers.get('last-event-id') ?? 0) || 0;

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const started = Date.now();
      let lastBeat = Date.now();
      let lastRaw: GameState | null = null;
      let closed = false;
      req.signal.addEventListener('abort', () => {
        closed = true;
      });

      const push = (raw: GameState, version: number) => {
        const payload = JSON.stringify({ state: redactForPlayer(raw, playerId) });
        controller.enqueue(encoder.encode(`id: ${version}\ndata: ${payload}\n\n`));
        lastSent = version;
        lastRaw = raw;
      };

      const syncAndSend = async () => {
        const result = await withGame(gameId); // runs + persists the sweep
        if (result.ok && result.version > lastSent) push(result.state, result.version);
        else if (result.ok) lastRaw = result.state;
      };

      try {
        await syncAndSend(); // immediate snapshot on (re)connect

        while (!closed && Date.now() - started < STREAM_LIFETIME_MS) {
          await new Promise((r) => setTimeout(r, TICK_MS));
          if (closed) break;

          const now = Date.now();
          const version = await kv.readVersion(gameId);
          if (version === 0) break; // game expired
          const sweepDue =
            lastRaw !== null && dueSweepAction(lastRaw, now, () => 0) !== null;
          if (version > lastSent || sweepDue) {
            await syncAndSend();
          } else if (now - lastBeat >= HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(`: ping\n\n`));
            lastBeat = now;
          }
        }
      } catch {
        // network drop or enqueue-after-close — the client will reconnect
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
