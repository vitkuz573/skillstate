/**
 * @non-paper LLM provider seam (Wave 4 DX).
 *
 * The paper core calls a bare `LLMFn` (`prompt => response text`) and
 * measures raw string chars itself (§4.3). This module adds an OPTIONAL,
 * additive provider interface for hosts that already report usage:
 *
 * - `LLMProvider.call(prompt, opts?)` resolves `{ text, usage? }` where
 *   `usage.promptChars` / `usage.completionChars` are RAW STRING CHARS
 *   (§4.3) reported by the caller — never tokenizer output;
 * - `fromLLMFn(fn)` wraps a plain `LLMFn` function into an `LLMProvider`
 *   (backwards compatibility; `LLMFn` itself is NOT removed);
 * - `isLLMProvider(v)` distinguishes `LLMFn | LLMProvider` at runtime
 *   (plain function = fn form, object with a `call` function = provider).
 *
 * The runtime accepts `llm: LLMFn | LLMProvider`: with a provider it
 * prefers `usage` over measuring strings, otherwise it measures exactly
 * as before. Zero dependencies, Node >= 20, ESM.
 */

/** Legacy LLM function: prompt in, raw response text out. Kept verbatim. */
export type LLMFnLike = (prompt: string) => Promise<string>;

/** @non-paper per-call options threaded into `LLMProvider.call`. */
export interface LLMCallOptions {
  /** AbortSignal for the in-flight call (runtime forwards its `signal?`). */
  signal?: AbortSignal;
}

/**
 * @non-paper usage reported by the provider, in raw string CHARS (§4.3).
 * Both fields are optional: missing values fall back to measuring the
 * corresponding string, exactly the plain `LLMFn` behavior.
 */
export interface LLMUsage {
  /** Raw chars of the prompt as sent (overrides `prompt.length`). */
  promptChars?: number;
  /** Raw chars of the completion text (overrides `text.length`). */
  completionChars?: number;
}

/** @non-paper provider result: raw text plus optional char usage. */
export interface LLMResult {
  text: string;
  usage?: LLMUsage;
}

/**
 * @non-paper LLM provider. `call` resolves the raw response text and,
 * when known, its char sizes — so metered hosts are not measured twice.
 */
export interface LLMProvider {
  call(prompt: string, opts?: LLMCallOptions): Promise<LLMResult>;
}

/**
 * @non-paper runtime guard: an object with a callable `call` is a
 * provider; anything else passed as `llm` is treated as a plain `LLMFn`.
 */
export function isLLMProvider(value: unknown): value is LLMProvider {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  return typeof (value as { call?: unknown }).call === 'function';
}

/**
 * @non-paper adapter: wrap a plain `LLMFn` function
 * into an `LLMProvider`. The wrapper honors an already-aborted `signal`
 * (rejects with `signal.reason`) and otherwise delegates verbatim —
 * no usage is synthesized, so the runtime measures strings as before.
 */
export function fromLLMFn(fn: LLMFnLike): LLMProvider {
  return {
    async call(prompt: string, opts?: LLMCallOptions): Promise<LLMResult> {
      if (opts?.signal?.aborted === true) {
        throw (opts.signal as AbortSignal).reason;
      }
      return { text: await fn(prompt) };
    },
  };
}
