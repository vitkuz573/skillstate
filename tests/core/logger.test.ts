import { describe, it, expect, vi, afterEach } from 'vitest';
import { JsonLogger } from '@skillstate/core';

afterEach(() => {
  vi.restoreAllMocks();
});

function capture() {
  const lines: string[] = [];
  const logger = new JsonLogger({ sink: (line) => lines.push(line), now: () => 1700000000000 });
  return { lines, logger };
}

describe('JsonLogger', () => {
  it('writes one JSON line per call with level/msg/ts', () => {
    const { lines, logger } = capture();
    logger.info('hello');
    logger.warn('careful');
    logger.error('boom');
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0])).toEqual({
      level: 'info',
      msg: 'hello',
      ts: 1700000000000,
    });
    expect(JSON.parse(lines[1]).level).toBe('warn');
    expect(JSON.parse(lines[2]).level).toBe('error');
  });

  it('merges structured fields into the line', () => {
    const { lines, logger } = capture();
    logger.info('step:end', { step: 2, action: 'deploy' });
    expect(JSON.parse(lines[0])).toEqual({
      level: 'info',
      msg: 'step:end',
      ts: 1700000000000,
      step: 2,
      action: 'deploy',
    });
  });

  it('redacts secrets in messages and fields (never leaks credentials)', () => {
    const { lines, logger } = capture();
    logger.info('token ghp_abcDEF1234567890XYZ used');
    logger.warn('key check', { detail: 'Bearer tok123abc-XYZ_~+/=' });
    logger.error('pem dump', {
      pem: '-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----',
    });
    for (const line of lines) {
      expect(line).not.toContain('ghp_');
      expect(line).not.toContain('tok123abc');
      expect(line).not.toContain('PRIVATE KEY');
    }
    expect(lines[0]).toContain('[REDACTED]');
    expect(lines[1]).toContain('Bearer [REDACTED]');
  });

  it('defaults to console.log and Date.now when constructed bare', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const before = Date.now();
    new JsonLogger().info('default-sink');
    const after = Date.now();
    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.msg).toBe('default-sink');
    expect(entry.ts).toBeGreaterThanOrEqual(before);
    expect(entry.ts).toBeLessThanOrEqual(after);
  });

  it('applies each default independently (sink-only / now-only)', () => {
    // now-only: still lands on console.log.
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new JsonLogger({ now: () => 123 }).info('now-only');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string).ts).toBe(123);

    // sink-only: ts falls back to Date.now.
    const lines: string[] = [];
    const before = Date.now();
    new JsonLogger({ sink: (line) => lines.push(line) }).warn('sink-only');
    expect(lines).toHaveLength(1);
    const ts = JSON.parse(lines[0]).ts as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it('accepts empty options (both defaults)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    new JsonLogger({}).error('empty-opts');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(spy.mock.calls[0][0] as string).level).toBe('error');
  });
});
