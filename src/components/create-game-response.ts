/**
 * Parse POST /api/games. An empty 500 used to throw in Safari as
 * "The string did not match the expected pattern."
 */
export async function readCreateResponse(
  res: Response
): Promise<{ gameId: string } | { error: string }> {
  const data = (await res.json().catch(() => ({}))) as {
    gameId?: unknown;
    error?: { message?: unknown };
  };
  if (res.ok && typeof data.gameId === 'string') return { gameId: data.gameId };
  const message =
    typeof data.error?.message === 'string' ? data.error.message : 'Failed to create game';
  return { error: message };
}
