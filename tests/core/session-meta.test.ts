import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  readSessionMeta,
  sessionMetaPath,
  sessionStaleness,
  SESSION_META_FILE,
  SESSION_STATUSES,
  STALE_MS,
  writeSessionMeta,
} from '@skillstate/core';

function makeTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-meta-'));
}

describe('session-meta sidecar', () => {
  it('sessionMetaPath joins the sidecar next to the state dir', () => {
    expect(sessionMetaPath('/x/.skillstate')).toBe(
      path.join('/x/.skillstate', SESSION_META_FILE),
    );
  });

  it('readSessionMeta returns null for a missing / corrupt / non-object sidecar', () => {
    const dir = makeTmp();
    expect(readSessionMeta(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, SESSION_META_FILE), '{corrupt', 'utf-8');
    expect(readSessionMeta(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, SESSION_META_FILE), '[1,2]', 'utf-8');
    expect(readSessionMeta(dir)).toBeNull();
    fs.writeFileSync(path.join(dir, SESSION_META_FILE), '"bare"', 'utf-8');
    expect(readSessionMeta(dir)).toBeNull();
  });

  it('writeSessionMeta creates the sidecar (pretty, newline-terminated)', async () => {
    const dir = makeTmp();
    const meta = await writeSessionMeta(dir, {
      status: 'running',
      startedAt: '2026-09-05T00:00:00.000Z',
      agentId: '',
    });
    expect(meta).toEqual({
      status: 'running',
      startedAt: '2026-09-05T00:00:00.000Z',
      agentId: '',
    });
    const raw = fs.readFileSync(path.join(dir, SESSION_META_FILE), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(JSON.parse(raw)).toEqual(meta);
  });

  it('writeSessionMeta merges under the lock and preserves unknown fields', async () => {
    const dir = makeTmp();
    await writeSessionMeta(dir, { status: 'running', custom: { nested: 1 } });
    const meta = await writeSessionMeta(dir, {
      status: 'completed',
      finishedAt: '2026-09-05T01:00:00.000Z',
      result: 'done',
    });
    expect(meta).toEqual({
      status: 'completed',
      finishedAt: '2026-09-05T01:00:00.000Z',
      result: 'done',
      custom: { nested: 1 },
    });
    // Repeated concurrent writes all land (the lock serializes them).
    await Promise.all([
      writeSessionMeta(dir, { result: 'a' }),
      writeSessionMeta(dir, { result: 'b' }),
    ]);
    expect(readSessionMeta(dir)?.result).toBeDefined();
  });

  it('writeSessionMeta creates missing directories', async () => {
    const dir = path.join(makeTmp(), 'agents', 'w1');
    await writeSessionMeta(dir, { status: 'running' });
    expect(readSessionMeta(dir)?.status).toBe('running');
  });

  it('covers every status value', () => {
    expect(SESSION_STATUSES).toEqual(['running', 'interrupted', 'completed', 'merged', 'failed']);
  });

  it('STALE_MS is the documented 5 minutes', () => {
    expect(STALE_MS).toBe(5 * 60 * 1000);
  });
});

describe('sessionStaleness', () => {
  const now = Date.parse('2026-09-05T12:00:00.000Z');

  it('orphan when there is no meta', () => {
    expect(sessionStaleness(null, now)).toBe('orphan');
  });

  it('active for a fresh running session', () => {
    expect(
      sessionStaleness(
        { status: 'running', lastActivityAt: new Date(now - 1000).toISOString() },
        now,
      ),
    ).toBe('active');
  });

  it('stale when running with the last activity older than STALE_MS', () => {
    expect(
      sessionStaleness(
        { status: 'running', lastActivityAt: new Date(now - STALE_MS - 1).toISOString() },
        now,
      ),
    ).toBe('stale');
  });

  it('stale falls back to startedAt when lastActivityAt is missing', () => {
    expect(
      sessionStaleness({ status: 'running', startedAt: new Date(now - STALE_MS - 1).toISOString() }, now),
      now,
    ).toBe('stale');
    expect(
      sessionStaleness({ status: 'running', startedAt: new Date(now - 1000).toISOString() }, now),
    ).toBe('active');
  });

  it('stale when running with no timestamps at all', () => {
    expect(sessionStaleness({ status: 'running' }, now)).toBe('stale');
  });

  it('terminal statuses are never stale (active even with an ancient timestamp)', () => {
    for (const status of ['interrupted', 'completed', 'merged', 'failed'] as const) {
      expect(
        sessionStaleness(
          { status, lastActivityAt: new Date(now - STALE_MS * 10).toISOString() },
          now,
        ),
      ).toBe('active');
    }
  });

  it('unparseable timestamps count as stale for a running session', () => {
    expect(sessionStaleness({ status: 'running', lastActivityAt: 'not-a-date' }, now)).toBe('stale');
  });
});
