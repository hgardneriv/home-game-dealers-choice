import { describe, expect, it } from 'vitest';
import { createGame } from '@/engine/engine';
import type { StoreResult } from './store';
import { json, readJson, storeResponse } from './api';

/** First-ever coverage of the small route helpers. */

describe('json()', () => {
  it('defaults to 200 with JSON + no-store headers and a serialized body', async () => {
    const res = json({ a: 1 });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('honors a custom status', () => {
    expect(json({ e: 'x' }, 418).status).toBe(418);
  });

  it('merges extra headers on top of the defaults', () => {
    const res = json({}, 200, { 'x-extra': 'yes', 'cache-control': 'private' });
    expect(res.headers.get('x-extra')).toBe('yes');
    expect(res.headers.get('cache-control')).toBe('private'); // caller wins
    expect(res.headers.get('content-type')).toBe('application/json');
  });
});

describe('readJson()', () => {
  function post(body: string): Request {
    return new Request('http://localhost/x', { method: 'POST', body });
  }

  it('returns a parsed object body', async () => {
    expect(await readJson(post('{"name":"Ada","seat":2}'))).toEqual({ name: 'Ada', seat: 2 });
  });

  it('returns {} for malformed JSON', async () => {
    expect(await readJson(post('{oops'))).toEqual({});
  });

  it('returns {} for JSON null', async () => {
    expect(await readJson(post('null'))).toEqual({});
  });

  it('returns {} for non-object JSON scalars', async () => {
    expect(await readJson(post('42'))).toEqual({});
    expect(await readJson(post('"hello"'))).toEqual({});
    expect(await readJson(post('true'))).toEqual({});
  });

  it('returns {} for an empty body', async () => {
    expect(await readJson(post(''))).toEqual({});
  });
});

describe('storeResponse()', () => {
  function okResult(): StoreResult {
    const state = createGame({
      id: 'gapi',
      hostId: 'h1',
      hostName: 'Host',
      now: Date.now(),
    });
    state.version = 1;
    return { ok: true, state, version: 1 };
  }

  it('returns 200 with the REDACTED state for the requesting player', async () => {
    const res = storeResponse(okResult(), 'h1');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('"deck"');
    expect(text).not.toContain('"holeCards"');
    const body = JSON.parse(text);
    expect(body.state.id).toBe('gapi');
    expect(body.state.yourId).toBe('h1');
    expect(body.state.players.h1.name).toBe('Host');
    expect(body.error).toBeUndefined();
  });

  it('supports anonymous viewers', async () => {
    const res = storeResponse(okResult(), null);
    const body = await res.json();
    expect(body.state.yourId).toBeNull();
  });

  it('maps an error result to its status and {error} body', async () => {
    const result: StoreResult = {
      ok: false,
      status: 404,
      error: { code: 'not-found', message: 'Game not found' },
    };
    const res = storeResponse(result, 'h1');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toEqual({ code: 'not-found', message: 'Game not found' });
    expect(body.state).toBeUndefined();
  });
});
