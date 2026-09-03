import { describe, it, expect } from 'vitest';
import {
  fromLLMFn,
  isLLMProvider,
} from '../../src/core/provider.js';

describe('isLLMProvider', () => {
  it('returns true for an object with a call function', () => {
    expect(isLLMProvider({ call: async () => ({ text: 'hi' }) })).toBe(true);
  });

  it('returns false for a plain function (legacy LLMFn)', () => {
    expect(isLLMProvider(async () => 'hi')).toBe(false);
  });

  it('returns false for null', () => {
    expect(isLLMProvider(null)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isLLMProvider('call')).toBe(false);
    expect(isLLMProvider(42)).toBe(false);
    expect(isLLMProvider(undefined)).toBe(false);
  });

  it('returns false for an object without a call function', () => {
    expect(isLLMProvider({})).toBe(false);
    expect(isLLMProvider({ call: 'not-a-function' })).toBe(false);
  });
});

describe('fromLLMFn', () => {
  it('delegates to the wrapped fn and returns text without usage', async () => {
    const seen: string[] = [];
    const provider = fromLLMFn(async (prompt) => {
      seen.push(prompt);
      return `echo:${prompt}`;
    });
    const result = await provider.call('hello');
    expect(result).toEqual({ text: 'echo:hello' });
    expect(seen).toEqual(['hello']);
  });

  it('accepts empty opts without a signal', async () => {
    const provider = fromLLMFn(async () => 'ok');
    await expect(provider.call('p', {})).resolves.toEqual({ text: 'ok' });
  });

  it('passes through a non-aborted signal', async () => {
    const provider = fromLLMFn(async () => 'ok');
    const controller = new AbortController();
    await expect(
      provider.call('p', { signal: controller.signal }),
    ).resolves.toEqual({ text: 'ok' });
  });

  it('rejects with signal.reason when already aborted', async () => {
    const provider = fromLLMFn(async () => 'unreachable');
    const controller = new AbortController();
    controller.abort(new Error('stop-now'));
    const failure = await provider
      .call('p', { signal: controller.signal })
      .then(
        () => null,
        (e) => e as Error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('stop-now');
  });
});
