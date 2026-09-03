/**
 * @non-paper resilience helpers — timeouts, retries with backoff+jitter,
 * and a circuit breaker for flaky LLM / executor calls.
 *
 * Nothing here changes paper semantics: these wrap the TRANSPORT (how long
 * we wait, how often we re-issue a failed call), never the Algorithm 1
 * prompt format, the ⊕ merge, or the §7 validation-retry cycle. All of it
 * is opt-in — the runtime only uses these when the caller passes the
 * @non-paper `timeoutMs` / `signal` / `retry` options.
 *
 * Zero dependencies, Node >= 20, ESM.
 */

/** Rejection reason for {@link withTimeout} when the deadline fires. */
export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/** Rejection reason for {@link CircuitBreaker.exec} while the circuit is open. */
export class CircuitOpenError extends Error {
  constructor() {
    super('Circuit breaker is open');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Race `promise` against a deadline (and, optionally, an AbortSignal).
 *
 * - Resolves/rejects with whatever `promise` settles to when it wins.
 * - Rejects with {@link TimeoutError} when `ms` elapses first.
 * - Rejects with `signal.reason` when `signal` is already aborted or aborts
 *   mid-flight. The timer is always cleared on settle so no handle leaks.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted) {
      reject((signal as AbortSignal).reason);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject((signal as AbortSignal).reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      reject(new TimeoutError(ms));
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** Options for {@link withRetry}. */
export interface RetryOptions {
  /** Retries AFTER the first attempt (total attempts = 1 + maxRetries). */
  maxRetries: number;
  /** Base backoff in ms; attempt n waits `baseMs * 2^n` (+ jitter). */
  baseMs: number;
  /** When true, add `Math.random() * backoff` on top of the backoff. */
  jitter?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Re-issue a rejected `fn` up to `maxRetries` times with exponential
 * backoff (`baseMs * 2^attempt`) and optional jitter. Resolves with the
 * first success; rethrows the last error when attempts are exhausted.
 * A `maxRetries` of 0 means a single attempt (no waiting).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  let lastError: unknown = null;
  const attempts = options.maxRetries + 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= options.maxRetries) {
        break;
      }
      const backoff = options.baseMs * 2 ** attempt;
      const delay =
        options.jitter === true ? backoff + Math.random() * backoff : backoff;
      if (delay > 0) {
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/** Observable circuit state. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Options for {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** Consecutive failures that trip the circuit from closed to open. */
  failureThreshold: number;
  /** Ms an open circuit waits before letting one trial call through. */
  resetTimeoutMs: number;
}

/**
 * Minimal circuit breaker (@non-paper transport guard).
 *
 * - `closed`: calls pass through; consecutive failures are counted and
 *   reset by any success. `failureThreshold` consecutive failures open it.
 * - `open`: calls are rejected immediately with {@link CircuitOpenError}
 *   without invoking `fn`. After `resetTimeoutMs` the next observed state
 *   (and the next `exec`) becomes `half-open`.
 * - `half-open`: a single trial call goes through. Success closes the
 *   circuit (counters reset); failure re-opens it (timeout restarts).
 */
export class CircuitBreaker {
  private failures = 0;
  private opened = false;
  private halfOpen = false;
  private openedAt = 0;

  constructor(private readonly options: CircuitBreakerOptions) {}

  /** Current state; lazily transitions open → half-open after the timeout. */
  get state(): CircuitState {
    if (
      this.opened &&
      !this.halfOpen &&
      Date.now() - this.openedAt >= this.options.resetTimeoutMs
    ) {
      this.halfOpen = true;
    }
    if (this.halfOpen) {
      return 'half-open';
    }
    if (this.opened) {
      return 'open';
    }
    return 'closed';
  }

  /**
   * Run `fn` through the circuit. Rejects with {@link CircuitOpenError}
   * while open; otherwise runs `fn` and records success/failure.
   */
  async exec<T>(fn: () => Promise<T>): Promise<T> {
    const current = this.state;
    if (current === 'open') {
      throw new CircuitOpenError();
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.halfOpen) {
      this.opened = false;
      this.halfOpen = false;
      this.failures = 0;
    } else {
      this.failures = 0;
    }
  }

  private onFailure(): void {
    if (this.halfOpen) {
      this.halfOpen = false;
      this.openedAt = Date.now();
    } else {
      this.failures += 1;
      if (this.failures >= this.options.failureThreshold) {
        this.opened = true;
        this.openedAt = Date.now();
      }
    }
  }
}
