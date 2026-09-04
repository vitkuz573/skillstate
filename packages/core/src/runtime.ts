import type {
  ProceduralSpec,
  SkillState,
  Observation,
  StatePatch,
} from './types.js';
import { StateManager } from './state-manager.js';
import { PromptTransformer } from './prompt-transformer.js';
import { withRetry, withTimeout } from './resilience.js';
import type { RetryOptions } from './resilience.js';
import type { TokenTracker } from './token-tracker.js';
import { clone } from './clock.js';
import type { Clock } from './clock.js';
import type { RuntimeEventEmitter } from './events.js';
import type { Logger } from './logger.js';
import type { LLMProvider, LLMUsage } from './provider.js';

/** LLM function: prompt in, response out. */
export interface LLMFn {
  (prompt: string): Promise<string>;
}

/** Action executor: runs the chosen action against the environment. */
export interface ActionExecutor {
  (action: string, state: SkillState): Promise<Observation>;
}

/**
 * Options for constructing a SkillStateRuntime.
 *
 * Paper-exact Algorithm 1 (§3.2) takes no size caps, no history budget, and
 * no token estimator: the prompt is At = (P, Σt, Ot) and nothing else.
 */
export interface RuntimeOptions {
  spec: ProceduralSpec;
  initialState?: SkillState;
  /**
   * Paper-exact `LLMFn` or the @non-paper `LLMProvider` seam (Wave 4 DX).
   * A function is called verbatim and measured in raw chars; a provider's
   * `usage` (raw chars, §4.3) is preferred over measuring when present.
   */
  llm: LLMFn | LLMProvider;
  execute: ActionExecutor;
  tracker?: TokenTracker;
  /**
   * Retries after the first failed attempt (§7 rollback-retry).
   * Default 2 (max attempts = 3).
   */
  maxValidationRetries?: number;
  /**
   * @non-paper resilience (additive, opt-in). Per-call deadline in ms for
   * the `llm`/`execute` transport calls. Unset = paper-exact direct calls
   * with no timeout layer at all.
   */
  timeoutMs?: number;
  /**
   * @non-paper resilience (additive, opt-in). AbortSignal threaded through
   * the `llm`/`execute` calls: an aborted signal rejects the in-flight call
   * with `signal.reason`. Unset = no abort handling.
   */
  signal?: AbortSignal;
  /**
   * @non-paper resilience (additive, opt-in). Transient transport-error
   * retries for `llm`/`execute` (thrown errors re-issued with backoff).
   * Orthogonal to `maxValidationRetries` (§7), which re-prompts on
   * invalid CONTENT. Unset = a single transport attempt.
   */
  retry?: RetryOptions;
  /**
   * @non-paper observability (additive, opt-in). Timestamps come from
   * `clock.now()` instead of `Date.now()`. Unset = paper-exact `Date.now()`
   * behavior; even an explicit `SystemClock` changes nothing observable.
   */
  clock?: Clock;
  /**
   * @non-paper observability (additive, opt-in). Receives
   * `step:start`/`step:end`/`step:error` (and `budget:exceeded` from
   * `run()`). Unset = nothing is emitted, zero overhead.
   */
  events?: RuntimeEventEmitter;
  /**
   * @non-paper observability (additive, opt-in). `info` per completed
   * step, `warn` on invalidated/budget-exceeded steps, `error` on
   * transport throws. Unset = silent.
   */
  logger?: Logger;
  /**
   * @non-paper char budget (additive, opt-in). Default cap for `run()`;
   * a per-call `RunOptions` value wins when both are set. Alias pair:
   * `tokenBudget`/`charsBudget` are interchangeable (chars, per §4.3 —
   * the "token" name is kept for caller convenience only).
   */
  tokenBudget?: CharsBudget;
  /** @non-paper alias of `tokenBudget` (additive, opt-in). */
  charsBudget?: CharsBudget;
}

/**
 * @non-paper char budget (chars, per paper §4.3 — never tokenizer output).
 * Trips when cumulative prompt+response chars EXCEED `maxChars` (`>`).
 * Unset `maxChars` = no cap.
 */
export interface CharsBudget {
  maxChars?: number;
}

/** @non-paper alias of {@link CharsBudget} (naming convenience only). */
export type TokenBudget = CharsBudget;

/**
 * @non-paper per-`run()` budget overrides. Precedence (first defined wins):
 * `maxChars` → `tokenBudget` → `charsBudget` → constructor
 * `tokenBudget` → constructor `charsBudget`. All optional, all additive.
 */
export interface RunOptions {
  tokenBudget?: CharsBudget;
  charsBudget?: CharsBudget;
  maxChars?: number;
}

/**
 * @non-paper rejection reason when `run()` trips a char budget. Carries
 * the committed prefix (`partialResults`, WITHOUT the exceeding step —
 * the trip rolls its state and tracker entry back) so callers can resume
 * or report deterministically.
 */
export class BudgetExceededError extends Error {
  readonly maxChars: number;
  readonly totalChars: number;
  readonly partialResults: StepResult[];

  constructor(
    maxChars: number,
    totalChars: number,
    partialResults: StepResult[],
  ) {
    super(`Char budget exceeded: ${totalChars} > ${maxChars}`);
    this.name = 'BudgetExceededError';
    this.maxChars = maxChars;
    this.totalChars = totalChars;
    this.partialResults = partialResults;
  }
}

/** Result of a single Algorithm 1 step. */
export interface StepResult {
  step: number;
  observation: Observation;
  reasoning: string;
  statePatch: StatePatch;
  action: string;
  newObservation: Observation;
  newState: SkillState;
  validationAttempts: number;
  invalidated: boolean;
  /**
   * @non-paper measured sizes for this step (raw string CHARS, §4.3):
   * `promptChars` is |At| (base prompt only — retry feedback is transport,
   * never part of At), `responseChars` accumulates every attempt's raw
   * response. Additive: paper consumers ignore them.
   */
  promptChars: number;
  responseChars: number;
}

/** Deterministic fallback action when the patch is rejected after all retries. */
const INVALID_PATCH_ACTION = '__invalid_patch__';
const DEFAULT_MAX_VALIDATION_RETRIES = 2;
const DEFAULT_MAX_STEPS = 100;
const FENCE_MARKER = '```json';
/**
 * @non-paper: `withTimeout` needs a numeric deadline, so signal-only waits
 * use the max setTimeout delay — effectively no timeout. The timer is
 * cleared on settle, so the process never actually waits this long.
 */
const SIGNAL_ONLY_TIMEOUT_MS = 0x7fffffff;

/**
 * Reasoning (Rt) is everything before the response's JSON fence. It is
 * returned to the caller but NEVER stored in state (§3.2: Rt discarded
 * permanently). Only called on responses that parsed successfully, so the
 * fence exists.
 */
function extractReasoning(response: string): string {
  return response.slice(0, response.indexOf(FENCE_MARKER)).trim();
}

/**
 * Re-prompt after a failed attempt (paper §7): same prompt plus corrective
 * feedback appended. Malformed outputs cannot corrupt Σt (Limitations) —
 * the state is only ever replaced by a validated merge.
 */
function withRetryFeedback(prompt: string, reason: string): string {
  return `${prompt}\n\nYour previous response was invalid: ${reason}. Respond again. Reasoning is discarded; respond with the JSON block with exactly these two keys: state_patch and action.`;
}

/** Accepted attempt: validated patch + action + the response's reasoning. */
interface AcceptedAttempt {
  patch: StatePatch;
  action: string;
  reasoning: string;
}

/**
 * Algorithm 1 runtime (paper §3.2) with the §7 rollback-retry cycle.
 *
 * Each step: format the paper-exact prompt At = (P, Σt, Ot), call the LLM,
 * parse the response (Rt, ΔΣt, at), validate ΔΣt against the schema, merge
 * it (Σt+1 = Σt ⊕ ΔΣt), and execute the action. The model never receives
 * previous observations, actions, or reasoning (§3). Failed attempts
 * re-prompt with corrective feedback; after exhausting retries the step
 * fails deterministically — the state is left untouched and the action
 * becomes `__invalid_patch__`.
 *
 * Reasoning is returned but never stored, and merged states are fresh
 * objects, so a rejected patch can never leak into state (rollback is free).
 */
export class SkillStateRuntime {
  private readonly spec: ProceduralSpec;
  private readonly llm: LLMFn | LLMProvider;
  private readonly execute: ActionExecutor;
  private readonly tracker: TokenTracker | undefined;
  private readonly maxValidationRetries: number;
  private readonly timeoutMs: number | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly retry: RetryOptions | undefined;
  private readonly clock: Clock | undefined;
  private readonly events: RuntimeEventEmitter | undefined;
  private readonly logger: Logger | undefined;
  private readonly tokenBudget: CharsBudget | undefined;
  private readonly charsBudget: CharsBudget | undefined;
  private readonly transformer = new PromptTransformer();
  private currentState: SkillState;
  private stepCounter = 0;

  constructor(options: RuntimeOptions) {
    this.spec = options.spec;
    this.llm = options.llm;
    this.execute = options.execute;
    this.tracker = options.tracker;
    this.maxValidationRetries =
      options.maxValidationRetries ?? DEFAULT_MAX_VALIDATION_RETRIES;
    this.timeoutMs = options.timeoutMs;
    this.signal = options.signal;
    this.retry = options.retry;
    this.clock = options.clock;
    this.events = options.events;
    this.logger = options.logger;
    this.tokenBudget = options.tokenBudget;
    this.charsBudget = options.charsBudget;
    this.currentState = options.initialState
      ? structuredClone(options.initialState)
      : StateManager.createInitialState(options.spec.schema);
  }

  /** Current state Σt (read-only copy). */
  get state(): SkillState {
    return structuredClone(this.currentState);
  }

  /**
   * @non-paper resilience wrapper (additive, opt-in).
   *
   * Paper path: no `timeoutMs`/`signal`/`retry` options — `fn` is invoked
   * directly, byte-for-byte the paper behavior (no timer, no extra attempt).
   * Resilience path: the call is threaded through `withTimeout` (deadline
   * and/or abort) and, when `retry` is set, transient throws are re-issued
   * via `withRetry`. Validation-retry (§7) semantics above this are
   * unchanged: a TRANSPORT throw still propagates out of `step` exactly as
   * a throwing `llm`/`execute` did before.
   */
  private invokeResilient<T>(fn: () => Promise<T>): Promise<T> {
    if (
      this.timeoutMs === undefined &&
      this.signal === undefined &&
      this.retry === undefined
    ) {
      return fn();
    }
    const attempt = (): Promise<T> => {
      const pending = fn();
      if (this.timeoutMs === undefined && this.signal === undefined) {
        return pending;
      }
      return withTimeout(
        pending,
        this.timeoutMs ?? SIGNAL_ONLY_TIMEOUT_MS,
        this.signal,
      );
    };
    if (this.retry === undefined) {
      return attempt();
    }
    return withRetry(attempt, this.retry);
  }

  /**
   * @non-paper LLM dispatch (Wave 4 DX, additive).
   *
   * Paper path: `llm` is a plain `LLMFn` function — called verbatim with the
   * prompt, exactly as before. Provider path: `llm.call(prompt, opts?)`
   * is used instead, forwarding the runtime `signal?` so aborts reach
   * the provider; both paths stay inside `invokeResilient`, so the
   * `timeoutMs`/`signal`/`retry` transport semantics are identical.
   */
  private invokeLLM(
    prompt: string,
  ): Promise<{ text: string; usage?: LLMUsage }> {
    const llm: LLMFn | LLMProvider = this.llm;
    if (typeof llm === 'function') {
      return this.invokeResilient(async () => ({ text: await llm(prompt) }));
    }
    const opts = this.signal !== undefined ? { signal: this.signal } : undefined;
    return this.invokeResilient(() => llm.call(prompt, opts));
  }

  /**
   * @non-paper timestamp source: injected `clock` or `Date.now()`.
   * The default path is exactly the paper core's `Date.now()`.
   */
  private now(): number {
    return this.clock?.now() ?? Date.now();
  }

  /** @non-paper: first defined budget cap wins (run-level beats ctor-level). */
  private resolveMaxChars(runOpts?: RunOptions): number | undefined {
    return (
      runOpts?.maxChars ??
      runOpts?.tokenBudget?.maxChars ??
      runOpts?.charsBudget?.maxChars ??
      this.tokenBudget?.maxChars ??
      this.charsBudget?.maxChars
    );
  }

  /** @non-paper: tracker total when tracked, local tally otherwise. */
  private currentTotalChars(localTotal: number): number {
    return this.tracker?.getBookkeeping().totalChars ?? localTotal;
  }

  /**
   * Execute one Algorithm 1 step for observation Ot.
   *
   * Paper-exact Algorithm 1 + §7 rollback-retry; the @non-paper
   * `events`/`logger` options only OBSERVE (emitted payloads never feed
   * back into prompts, merges, or validation).
   */
  async step(observation: Observation): Promise<StepResult> {
    this.stepCounter += 1;
    const stepNumber = this.stepCounter;
    this.events?.emit('step:start', { step: stepNumber, observation });

    try {
      // 1. Construct the prompt At = (P, Σt, Ot) — paper-exact format.
      // The observation is passed through verbatim: no trimming, no size
      // rejection. The O(1) footprint is a property of the method (no
      // history is ever re-sent), not of input caps.
      const basePrompt = this.transformer.formatPaper(
        this.spec,
        this.currentState,
        observation,
      );
      const maxAttempts = 1 + this.maxValidationRetries;

      let prompt = basePrompt;
      let response = '';
      let lastError = '';
      let attempts = 0;
      let accepted: AcceptedAttempt | null = null;
      let responseChars = 0;
      let promptCharsOverride: number | undefined;

      // 2-4. Call the LLM, parse, validate — retrying with corrective feedback
      // on parse or validation failure (§7 rollback-retry cycle).
      while (attempts < maxAttempts) {
        attempts += 1;
        const produced = await this.invokeLLM(prompt);
        response = produced.text;
        const usage = produced.usage;
        if (promptCharsOverride === undefined && usage?.promptChars !== undefined) {
          promptCharsOverride = usage.promptChars;
        }
        responseChars += usage?.completionChars ?? response.length;

        const parsed = this.transformer.parseResponse(response);
        if (parsed.ok) {
          const validation = StateManager.validatePatch(
            this.spec.schema,
            parsed.patch,
          );
          if (validation.valid) {
            accepted = {
              patch: parsed.patch,
              action: parsed.action,
              reasoning: extractReasoning(response),
            };
            break;
          } else {
            lastError = validation.error;
          }
        } else {
          lastError = parsed.detail ?? parsed.reason;
        }
        prompt = withRetryFeedback(basePrompt, lastError);
      }

      // 5. On success: Σt+1 = Σt ⊕ ΔΣt. On exhaustion: state UNCHANGED —
      // immutability makes rollback free (there is nothing to undo).
      const invalidated = accepted === null;
      const patch: StatePatch = accepted === null ? {} : accepted.patch;
      const action =
        accepted === null ? INVALID_PATCH_ACTION : accepted.action;
      const reasoning = accepted === null ? '' : accepted.reasoning;
      const newState =
        accepted === null
          ? this.currentState
          : StateManager.mergeState(this.currentState, accepted.patch);

      // 6. Execute at → new observation (synthesized error observation on
      // exhaustion; the sentinel action is never executed).
      const newObservation: Observation =
        accepted === null
          ? {
              content: `Invalid state patch after ${attempts} attempts: ${lastError}`,
              timestamp: this.now(),
              source: 'skillstate',
            }
          : await this.invokeResilient(() => this.execute(action, newState));

      // 7. Record the step in the tracker. Sizes are raw string CHARS (§4.3):
      // promptChars is |At| — measured, unless a provider reported
      // `usage.promptChars` (preferred verbatim); responseChars accumulates
      // every attempt's raw response (`usage.completionChars` when reported).
      // No tokenizer, no estimates, no retry-separate accounting.
      const promptChars = promptCharsOverride ?? basePrompt.length;
      this.tracker?.recordStep({
        step: stepNumber,
        observation,
        reasoning,
        statePatch: patch,
        action,
        promptChars,
        responseChars,
        timestamp: this.now(),
        success: !invalidated,
      });

      if (accepted !== null) {
        this.currentState = newState;
      }

      // @non-paper observability (never feeds back into Algorithm 1).
      this.events?.emit('step:end', { step: stepNumber, action, invalidated });
      if (invalidated) {
        this.events?.emit('step:error', { step: stepNumber, error: lastError });
        this.logger?.warn('step:invalidated', { step: stepNumber, error: lastError });
      } else {
        this.logger?.info('step:end', { step: stepNumber, action });
      }

      // 8. Return the step result (reasoning is returned, never stored)
      return {
        step: stepNumber,
        observation,
        reasoning,
        statePatch: patch,
        action,
        newObservation,
        newState,
        validationAttempts: attempts,
        invalidated,
        promptChars,
        responseChars,
      };
    } catch (error) {
      // @non-paper: transport throws (llm/execute, timeouts, aborts) still
      // propagate exactly as before — observed first, never swallowed.
      const message = error instanceof Error ? error.message : String(error);
      this.events?.emit('step:error', { step: stepNumber, error: message });
      this.logger?.error('step:error', { step: stepNumber, error: message });
      throw error;
    }
  }

  /**
   * Run steps until isDone(result) is true or maxSteps is reached. Each
   * step's input observation is the previous step's newObservation.
   *
   * @non-paper `runOpts`/constructor budgets cap cumulative CHARS
   * (prompt+response, §4.3). On trip the exceeding step is rolled back —
   * runtime state restored, its tracker entry truncated — and
   * `BudgetExceededError` (with the committed prefix) is thrown alongside
   * a `budget:exceeded` event. No budget = the paper-exact loop above,
   * untouched.
   */
  async run(
    first: Observation,
    isDone: (r: StepResult) => boolean,
    maxSteps: number = DEFAULT_MAX_STEPS,
    runOpts?: RunOptions,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    const maxChars = this.resolveMaxChars(runOpts);
    let localTotal = 0;

    let observation = first;

    for (let i = 0; i < maxSteps; i += 1) {
      if (
        maxChars !== undefined &&
        this.currentTotalChars(localTotal) > maxChars
      ) {
        // Resumed into an already-blown budget: stop before any new commit.
        const total = this.currentTotalChars(localTotal);
        this.events?.emit('budget:exceeded', {
          step: results.length + 1,
          totalChars: total,
          maxChars,
        });
        this.logger?.warn('budget:exceeded', {
          step: results.length + 1,
          totalChars: total,
          maxChars,
        });
        throw new BudgetExceededError(maxChars, total, results);
      }

      const trackerCountBefore = this.tracker?.getBookkeeping().stepCount ?? 0;
      const stateBefore = clone(this.currentState);
      const result = await this.step(observation);
      const totalAfter = this.currentTotalChars(
        localTotal + result.promptChars + result.responseChars,
      );

      if (maxChars !== undefined && totalAfter > maxChars) {
        // Roll back the exceeding step: no partial commit survives.
        this.currentState = stateBefore;
        this.tracker?.truncateTo(trackerCountBefore);
        this.events?.emit('budget:exceeded', {
          step: result.step,
          totalChars: totalAfter,
          maxChars,
        });
        this.logger?.warn('budget:exceeded', {
          step: result.step,
          totalChars: totalAfter,
          maxChars,
        });
        throw new BudgetExceededError(maxChars, totalAfter, results);
      }

      if (this.tracker === undefined) {
        localTotal += result.promptChars + result.responseChars;
      }
      results.push(result);
      if (isDone(result)) {
        break;
      }
      observation = result.newObservation;
    }

    return results;
  }
}
