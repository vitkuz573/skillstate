import type {
  ProceduralSpec,
  SkillState,
  Observation,
  StatePatch,
} from './types.js';
import { StateManager } from './state-manager.js';
import { PromptTransformer } from './prompt-transformer.js';
import type { TokenTracker } from './token-tracker.js';

/** LLM function: prompt in, response out. */
export interface LLMFn {
  (prompt: string): Promise<string>;
}

/** Action executor: runs the chosen action against the environment. */
export interface ActionExecutor {
  (action: string, state: SkillState): Promise<Observation>;
}

/** Options for constructing a SkillStateRuntime. */
export interface RuntimeOptions {
  spec: ProceduralSpec;
  initialState?: SkillState;
  llm: LLMFn;
  execute: ActionExecutor;
  tracker?: TokenTracker;
  /** Retries after the first failed attempt. Default 2 (max attempts = 3). */
  maxValidationRetries?: number;
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
}

/** Deterministic fallback action when the patch is rejected after all retries. */
const INVALID_PATCH_ACTION = '__invalid_patch__';
const DEFAULT_MAX_VALIDATION_RETRIES = 2;
const DEFAULT_MAX_STEPS = 100;
const FENCE_MARKER = '```json';

/**
 * Reasoning (Rt) is everything before the response's JSON fence. It is
 * returned to the caller but NEVER stored in state (the paper discards it).
 * Only called on responses that parsed successfully, so the fence exists.
 */
function extractReasoning(response: string): string {
  return response.slice(0, response.indexOf(FENCE_MARKER)).trim();
}

/**
 * Re-prompt after a failed attempt (paper §7): same prompt plus corrective
 * feedback appended.
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
 * Each step: format the paper-exact prompt (P, Σt, Ot), call the LLM, parse
 * the response, validate ΔΣt against the schema, merge it (Σt+1 = Σt ⊕ ΔΣt),
 * and execute the action. Failed attempts re-prompt with corrective feedback;
 * after exhausting retries the step falls back deterministically — the state
 * is left untouched and the action becomes `__invalid_patch__`.
 *
 * Reasoning is returned but never stored, and merged states are fresh
 * objects, so a rejected patch can never leak into state (rollback is free).
 */
export class SkillStateRuntime {
  private readonly spec: ProceduralSpec;
  private readonly llm: LLMFn;
  private readonly execute: ActionExecutor;
  private readonly tracker: TokenTracker | undefined;
  private readonly maxValidationRetries: number;
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
    this.currentState = options.initialState
      ? structuredClone(options.initialState)
      : StateManager.createInitialState(options.spec.schema);
  }

  /** Current state Σt (read-only copy). */
  get state(): SkillState {
    return structuredClone(this.currentState);
  }

  /**
   * Execute one Algorithm 1 step for observation Ot.
   */
  async step(observation: Observation): Promise<StepResult> {
    this.stepCounter += 1;
    const stepNumber = this.stepCounter;

    // 1. Construct the prompt (P, Σt, Ot) — paper-exact format
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

    // 2-4. Call the LLM, parse, validate — retrying with corrective feedback
    // on parse or validation failure (§7 rollback-retry cycle).
    while (attempts < maxAttempts) {
      attempts += 1;
      response = await this.llm(prompt);

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
        }
        lastError = validation.error;
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
            timestamp: Date.now(),
            source: 'skillstate',
          }
        : await this.execute(action, newState);

    // 7. Record the step in the tracker
    const promptTokens = Math.ceil(prompt.length / 4);
    const responseTokens = Math.ceil(response.length / 4);
    this.tracker?.recordStep({
      step: stepNumber,
      observation,
      reasoning,
      statePatch: patch,
      action,
      tokensUsed: promptTokens + responseTokens,
      promptSize: promptTokens,
      timestamp: Date.now(),
      success: !invalidated,
    });

    if (accepted !== null) {
      this.currentState = newState;
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
    };
  }

  /**
   * Run steps until isDone(result) is true or maxSteps is reached. Each
   * step's input observation is the previous step's newObservation.
   */
  async run(
    first: Observation,
    isDone: (r: StepResult) => boolean,
    maxSteps: number = DEFAULT_MAX_STEPS,
  ): Promise<StepResult[]> {
    const results: StepResult[] = [];
    let observation = first;

    for (let i = 0; i < maxSteps; i += 1) {
      const result = await this.step(observation);
      results.push(result);
      if (isDone(result)) {
        break;
      }
      observation = result.newObservation;
    }

    return results;
  }
}
