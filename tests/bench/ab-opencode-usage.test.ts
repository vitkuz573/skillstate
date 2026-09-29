/**
 * The live read: token usage over an OpenCode server's HTTP API.
 *
 * Covered with fixture payloads rather than a running server, because the
 * thing worth testing here is the SHAPE ADAPTER — how the host's message
 * envelope becomes a row — and that is a pure function of the payload. A
 * test that needed a live server would verify reachability, which is the
 * network's property, not this code's.
 */

import { describe as group, it, expect } from 'vitest';
import { serverSessionUsage, serverUsageReader } from '@skillstate/bench';
import type { ServerFetcher } from '@skillstate/bench';

/** One message as the host's API returns it, with optional omissions. */
function message(overrides: Record<string, unknown> = {}): unknown {
  return {
    info: {
      sessionID: 'ses_1',
      role: 'assistant',
      time: { created: 1000 },
      tokens: {
        input: 1368,
        output: 60,
        reasoning: 134,
        cache: { read: 41088, write: 0 },
      },
    },
    ...overrides,
  };
}

/** A fetcher function returning a fixed body. */
function fetcherReturning(body: unknown): ServerFetcher['get'] {
  return async (): Promise<unknown> => body;
}

/** A fetcher function that always throws. */
function failingFetcher(message: string): ServerFetcher['get'] {
  return async (): Promise<unknown> => {
    throw new Error(message);
  };
}

const BASE = 'http://localhost:4096';

group('serverUsageReader', () => {
  it('requests the message endpoint for the given session', async () => {
    const paths: string[] = [];
    const reader = serverUsageReader(BASE, async (path: string) => {
      paths.push(path);
      return [];
    });
    await reader.messagesFor('ses_1');
    expect(paths).toEqual(['http://localhost:4096/api/session/ses_1/message']);
  });

  it('strips a trailing slash from the base URL', async () => {
    // `//api/...` is a different path and would 404 in a way that looks like
    // "session has no messages".
    const paths: string[] = [];
    await serverUsageReader(`${BASE}/`, async (path: string) => {
      paths.push(path);
      return [];
    }).messagesFor('ses_1');
    expect(paths[0]).toBe('http://localhost:4096/api/session/ses_1/message');
  });

  it('escapes a session id that contains URL-significant characters', async () => {
    const paths: string[] = [];
    await serverUsageReader(BASE, async (path: string) => {
      paths.push(path);
      return [];
    }).messagesFor('a/b?c');
    expect(paths[0]).toBe('http://localhost:4096/api/session/a%2Fb%3Fc/message');
  });

  it('folds reasoning tokens into output', async () => {
    // Reasoning is generated, is billed as generated, and excluding it would
    // make a thinking-heavy run look cheaper than it was.
    const usage = await serverSessionUsage(BASE, fetcherReturning([message()]), 'ses_1');
    expect(usage.ok).toBe(true);
    if (usage.ok) expect(usage.usage.output).toBe(194);
  });

  it('reads the cache buckets', async () => {
    const usage = await serverSessionUsage(BASE, fetcherReturning([message()]), 'ses_1');
    if (usage.ok) {
      expect(usage.usage.cacheRead).toBe(41088);
      expect(usage.usage.cacheWrite).toBe(0);
    }
  });

  it('counts only assistant messages', async () => {
    const body = [
      message({ info: { sessionID: 'ses_1', role: 'user', time: { created: 1 }, tokens: { input: 5000 } } }),
      message(),
    ];
    const usage = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    if (usage.ok) {
      expect(usage.assistantMessages).toBe(1);
      expect(usage.usage.input).toBe(1368);
    }
  });

  it('treats a non-array body as no messages', async () => {
    // A server that answers with an object instead of a list is not a run
    // that cost nothing.
    const outcome = await serverSessionUsage(BASE, fetcherReturning({ error: 'nope' }), 'ses_1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('session_unknown');
  });

  it('treats a null entry and a null info as a row with no tokens', async () => {
    const body = [null, { info: null }];
    const outcome = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.usage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
  });

  it('fills absent token fields with zero rather than NaN', async () => {
    const body = [message({ info: { sessionID: 'ses_1', role: 'assistant', time: { created: 1 }, tokens: {} } })];
    const outcome = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    if (outcome.ok) {
      expect(outcome.usage).toEqual({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0 });
    }
  });

  it('ignores a non-numeric token value', async () => {
    // A string or NaN slipping into the sum would poison every later total.
    const body = [message({
      info: {
        sessionID: 'ses_1',
        role: 'assistant',
        time: { created: 1 },
        tokens: { input: 'many', output: 10, cache: { read: Number.NaN } },
      },
    })];
    const outcome = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    if (outcome.ok) {
      expect(outcome.usage.input).toBe(0);
      expect(outcome.usage.output).toBe(10);
      expect(outcome.usage.cacheRead).toBe(0);
    }
  });

  it('falls back to the envelope timestamp when info has no time', async () => {
    const reader = serverUsageReader(BASE, fetcherReturning([{ created: 555, info: { role: 'assistant' } }]));
    const rows = await reader.messagesFor('ses_1');
    expect(rows[0]!.created).toBe(555);
  });

  it('defaults a missing role to unknown, which the sum then skips', async () => {
    const body = [message({ info: { sessionID: 'ses_1', time: { created: 1 }, tokens: { input: 99 } } })];
    const outcome = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    if (outcome.ok) {
      expect(outcome.assistantMessages).toBe(0);
      expect(outcome.usage.input).toBe(0);
    }
  });

  it('treats a message with no token record as having none', async () => {
    const body = [message({ info: { sessionID: 'ses_1', role: 'assistant', time: { created: 1 } } })];
    const outcome = await serverSessionUsage(BASE, fetcherReturning(body), 'ses_1');
    if (outcome.ok) expect(outcome.usage.input).toBe(0);
  });

  it('propagates a transport failure as store_unavailable, not as zero', async () => {
    const outcome = await serverSessionUsage(BASE, failingFetcher('ECONNREFUSED'), 'ses_1');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe('store_unavailable');
      expect(outcome.detail).toContain('ECONNREFUSED');
    }
  });
});
