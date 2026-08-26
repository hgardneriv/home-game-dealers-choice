import { describe, expect, it } from 'vitest';
import { readCreateResponse } from './create-game-response';

describe('readCreateResponse', () => {
  it('maps an empty 500 to a fallback, not a JSON parse error', async () => {
    const res = new Response('', { status: 500 });
    const result = await readCreateResponse(res);
    expect(result).toEqual({ error: 'Failed to create game' });
    expect('error' in result && result.error).not.toMatch(/expected pattern/i);
  });

  it('surfaces the server error message when the body is JSON', async () => {
    const res = new Response(
      JSON.stringify({
        error: {
          code: 'storage-unavailable',
          message: 'The table service is busy — try again in a minute',
        },
      }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    );
    expect(await readCreateResponse(res)).toEqual({
      error: 'The table service is busy — try again in a minute',
    });
  });
});
