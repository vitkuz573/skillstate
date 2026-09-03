import { describe, it, expect } from 'vitest';
import {
  TimeoutError,
  CircuitOpenError,
  CircuitBreaker,
  withRetry,
  withTimeout,
} from '@skillstate/core';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function never(): Promise<string> {
  return new Promise<string>(() => {});
}

// ─── withTimeout ────────────────────────────────────────────────────────────

describe('withTimeout', () => {
  it('resolves with the promise value when it settles first (no signal)', async () => {
    await expect(withTimeout(Promise.resolve('fast'), 50)).resolves.toBe(
      'fast',
    );
  });

  it('rejects with the original error when the promise rejects first (no signal)', async () => {
    await expect(
      withTimeout(Promise.reject(new Error('inner-boom')), 50),
    ).rejects.toThrow('inner-boom');
  });

  it('rejects with TimeoutError after the deadline (no signal)', async () => {
    const error = await withTimeout(never(), 10).catch((e) => e);
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toBe('Timed out after 10ms');
  });

  it('resolves with a non-aborted signal attached', async () => {
    const controller = new AbortController();
    const result = await withTimeout(Promise.resolve('ok'), 50, controller.signal);
    expect(result).toBe('ok');
    // Aborting after settle is a no-op for the settled wrapper.
    controller.abort(new Error('late'));
    await expect(
      withTimeout(Promise.resolve('still-ok'), 50, controller.signal),
    ).rejects.toThrow('late');
  });

  it('rejects with the original error with a signal attached', async () => {
    const controller = new AbortController();
    await expect(
      withTimeout(
        Promise.reject(new Error('inner-with-signal')),
        50,
        controller.signal,
      ),
    ).rejects.toThrow('inner-with-signal');
  });

  it('times out with a signal attached (listener is cleaned up)', async () => {
    const controller = new AbortController();
    const error = await withTimeout(never(), 10, controller.signal).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe('Timed out after 10ms');
  });

  it('rejects immediately with signal.reason when already aborted', async () => {
    const controller = new AbortController();
    controller.abort(new Error('pre-aborted'));
    await expect(
      withTimeout(Promise.resolve('unused'), 50, controller.signal),
    ).rejects.toThrow('pre-aborted');
  });

  it('rejects with signal.reason when aborted mid-flight (timer cleared)', async () => {
    const controller = new AbortController();
    const pending = withTimeout(never(), 1000, controller.signal);
    const assertion = expect(pending).rejects.toThrow('mid-flight');
    controller.abort(new Error('mid-flight'));
    await assertion;
  });

  it('rejects with the default AbortError when aborted without a reason', async () => {
    const controller = new AbortController();
    const pending = withTimeout(never(), 1000, controller.signal);
    const assertion = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    controller.abort();
    await assertion;
  });
});

// ─── withRetry ──────────────────────────────────────────────────────────────

describe('withRetry', () => {
  it('returns the first success without waiting', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        return 'first-try';
      },
      { maxRetries: 3, baseMs: 5 },
    );
    expect(result).toBe('first-try');
    expect(calls).toBe(1);
  });

  it('retries a transient failure and succeeds (zero backoff, no jitter)', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('flaky');
        }
        return 'recovered';
      },
      { maxRetries: 2, baseMs: 0 },
    );
    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('waits exponential backoff between attempts (no jitter)', async () => {
    let calls = 0;
    const started = Date.now();
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error(`fail-${calls}`);
        }
        return 'eventual';
      },
      { maxRetries: 3, baseMs: 10, jitter: false },
    );
    expect(result).toBe('eventual');
    expect(calls).toBe(3);
    // Backoff waits 10ms then 20ms before the winning attempt.
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });

  it('succeeds after a retry with jitter enabled', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('flaky-jitter');
        }
        return 'recovered-jitter';
      },
      { maxRetries: 2, baseMs: 1, jitter: true },
    );
    expect(result).toBe('recovered-jitter');
    expect(calls).toBe(2);
  });

  it('rethrows the last error after exhausting attempts', async () => {
    let calls = 0;
    const error = await withRetry(
      async (): Promise<string> => {
        calls += 1;
        throw new Error(`always-fails-${calls}`);
      },
      { maxRetries: 2, baseMs: 0 },
    ).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('always-fails-3');
    expect(calls).toBe(3); // 1 + maxRetries
  });

  it('exhausts with jitter enabled and reports the last error', async () => {
    let calls = 0;
    const error = await withRetry(
      async (): Promise<string> => {
        calls += 1;
        throw new Error(`jitter-fail-${calls}`);
      },
      { maxRetries: 1, baseMs: 1, jitter: true },
    ).catch((e) => e);
    expect(error.message).toBe('jitter-fail-2');
    expect(calls).toBe(2);
  });

  it('maxRetries 0 means a single attempt', async () => {
    let calls = 0;
    const error = await withRetry(
      async (): Promise<string> => {
        calls += 1;
        throw new Error('only-once');
      },
      { maxRetries: 0, baseMs: 5 },
    ).catch((e) => e);
    expect(error.message).toBe('only-once');
    expect(calls).toBe(1);
  });
});

// ─── CircuitBreaker ─────────────────────────────────────────────────────────

describe('CircuitBreaker', () => {
  it('starts closed and passes calls through', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30,
    });
    expect(breaker.state).toBe('closed');
    await expect(breaker.exec(async () => 'v')).resolves.toBe('v');
    expect(breaker.state).toBe('closed');
  });

  it('stays closed below the threshold and resets the count on success', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30,
    });
    await expect(breaker.exec(async () => 'ok')).resolves.toBe('ok');
    // One failure is not enough to open (covers threshold-not-reached).
    await expect(
      breaker.exec(async () => {
        throw new Error('single');
      }),
    ).rejects.toThrow('single');
    expect(breaker.state).toBe('closed');
    // Success resets the consecutive-failure count: one more failure still
    // does not open the circuit.
    await expect(breaker.exec(async () => 'ok-again')).resolves.toBe(
      'ok-again',
    );
    await expect(
      breaker.exec(async () => {
        throw new Error('single-again');
      }),
    ).rejects.toThrow('single-again');
    expect(breaker.state).toBe('closed');
  });

  it('opens after threshold consecutive failures and rejects without calling fn', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 2,
      resetTimeoutMs: 30,
    });
    await breaker.exec(async () => 'warm').catch(() => {});
    for (let i = 0; i < 2; i += 1) {
      await expect(
        breaker.exec(async () => {
          throw new Error(`fail-${i}`);
        }),
      ).rejects.toThrow(`fail-${i}`);
    }
    expect(breaker.state).toBe('open');

    let called = false;
    const error = await breaker
      .exec(async () => {
        called = true;
        return 'never';
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect(error.name).toBe('CircuitOpenError');
    expect(called).toBe(false);
    // Still open immediately after (timeout not elapsed).
    expect(breaker.state).toBe('open');
  });

  it('transitions open → half-open after the timeout, then closes on success', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 20,
    });
    await expect(
      breaker.exec(async () => {
        throw new Error('trip');
      }),
    ).rejects.toThrow('trip');
    expect(breaker.state).toBe('open');

    await sleep(40);
    expect(breaker.state).toBe('half-open');
    await expect(breaker.exec(async () => 'trial-ok')).resolves.toBe(
      'trial-ok',
    );
    expect(breaker.state).toBe('closed');
  });

  it('re-opens when the half-open trial fails, then allows another trial later', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 20,
    });
    await expect(
      breaker.exec(async () => {
        throw new Error('trip');
      }),
    ).rejects.toThrow('trip');

    await sleep(40);
    expect(breaker.state).toBe('half-open');
    await expect(
      breaker.exec(async () => {
        throw new Error('trial-fails');
      }),
    ).rejects.toThrow('trial-fails');
    // Failed trial re-opens the circuit immediately.
    expect(breaker.state).toBe('open');

    await sleep(40);
    expect(breaker.state).toBe('half-open');
    await expect(breaker.exec(async () => 'second-trial-ok')).resolves.toBe(
      'second-trial-ok',
    );
    expect(breaker.state).toBe('closed');
  });

  it('propagates the original error (not a breaker error) on failure', async () => {
    const breaker = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30,
    });
    const original = new Error('original-failure');
    const caught = await breaker
      .exec(async () => {
        throw original;
      })
      .catch((e) => e);
    expect(caught).toBe(original);
  });
});
