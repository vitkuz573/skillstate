import { describe, it, expect } from 'vitest';
import {
  RuntimeEventEmitter,
  runtimeEvents,
} from '@skillstate/core';

describe('RuntimeEventEmitter', () => {
  it('delivers typed payloads to subscribers', () => {
    const emitter = new RuntimeEventEmitter();
    const seen: Array<{ step: number; action: string; invalidated: boolean }> =
      [];
    emitter.on('step:end', (payload) => {
      seen.push(payload);
    });
    emitter.emit('step:end', { step: 2, action: 'go', invalidated: false });
    expect(seen).toEqual([{ step: 2, action: 'go', invalidated: false }]);
  });

  it('supports several listeners per event in subscription order', () => {
    const emitter = new RuntimeEventEmitter();
    const order: string[] = [];
    emitter.on('step:start', () => {
      order.push('first');
    });
    emitter.on('step:start', () => {
      order.push('second');
    });
    emitter.emit('step:start', {
      step: 1,
      observation: { content: 'o', timestamp: 0 },
    });
    expect(order).toEqual(['first', 'second']);
  });

  it('off removes a listener; unknown offs are no-ops', () => {
    const emitter = new RuntimeEventEmitter();
    let calls = 0;
    const listener = (): void => {
      calls += 1;
    };
    emitter.on('budget:exceeded', listener);
    emitter.off('budget:exceeded', listener);
    // Off for an event with no listeners at all never throws.
    emitter.off('step:error', listener);
    emitter.emit('budget:exceeded', { step: 1, totalChars: 9, maxChars: 5 });
    expect(calls).toBe(0);
  });

  it('on returns an unsubscribe closure', () => {
    const emitter = new RuntimeEventEmitter();
    let calls = 0;
    const unsubscribe = emitter.on('step:error', () => {
      calls += 1;
    });
    unsubscribe();
    emitter.emit('step:error', { step: 1, error: 'boom' });
    expect(calls).toBe(0);
  });

  it('emit to an event with no listeners is a silent no-op', () => {
    const emitter = new RuntimeEventEmitter();
    expect(() =>
      emitter.emit('step:start', {
        step: 1,
        observation: { content: 'o', timestamp: 0 },
      }),
    ).not.toThrow();
  });

  it('exposes a shared process-wide singleton', () => {
    expect(runtimeEvents).toBeInstanceOf(RuntimeEventEmitter);
  });
});
