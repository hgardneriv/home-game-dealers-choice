import type { StoreResult } from './store';
import { redactForPlayer } from './redact';

export function json(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Standard response for a store call: redacted state on success, error otherwise. */
export function storeResponse(result: StoreResult, playerId: string | null): Response {
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({ state: redactForPlayer(result.state, playerId) });
}
