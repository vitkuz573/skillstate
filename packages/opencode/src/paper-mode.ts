/**
 * Paper mode — the model-facing context rebuilt as `Aₜ = (P, Σₜ, Oₜ)`.
 *
 * ── Why this module exists, and why it contradicts what came before ────────
 *
 * The previous version of this plugin refused to touch `event.messages` at
 * all. That was a genuine fix for a real defect — the v1 plugin truncated
 * history and injected state as a synthetic `role: "user"` message, which
 * deleted the task statement and displaced the user's request — but it was
 * a fix in the wrong direction.
 *
 * SKILL.state (arXiv:2608.26263v3) does not merely permit discarding the
 * transcript, it requires it:
 *
 * > "The language model never receives previous observations, previous
 * > actions, or previous reasoning traces." (§3)
 *
 * and Appendix A.4 fixes the prompt shape exactly:
 *
 * ```
 * Instructions:
 * {skill.instructions}
 *
 * Skill Execution State:
 * ```json
 * {json.dumps(state, separators=(',',':'))}
 * ```
 * Latest Observation: {observation}
 * ...
 * ```
 *
 * So replacing the model-facing context is the SPEC, not a violation. The
 * violation was reconstructing it badly.
 *
 * ── What is actually destroyed, and what is not ───────────────────────────
 *
 * `event.messages` is the view handed to the MODEL. It is not the session's
 * persisted history: the user-visible transcript in the session store is
 * untouched, and so is `skillstate_read` / `skillstate_update` — the agent
 * can still see everything it wrote, because that is in Σₜ, which is in the
 * prompt. What the model stops seeing is the raw reasoning and tool-output
 * trail, which the paper's §3.2 discards by construction ("the reasoning
 * trace Rₜ is discarded permanently and never appears in subsequent
 * prompts").
 *
 * ── The one thing paper mode must never lose ─────────────────────────────
 *
 * O₀ — the user's original request — is an OBSERVATION, not part of P. If it
 * is dropped, the agent has no task and the failure looks exactly like the
 * v1 bug. {@link initialTask} therefore pins the first user message and
 * every later step still carries it as P's preamble, because a procedure
 * spec authored before the task is known cannot contain it.
 *
 * ── The honest limit of a host plugin ────────────────────────────────────
 *
 * Algorithm 1 also requires the RUNTIME to execute `aₜ` and feed back Oₜ₊₁.
 * An OpenCode plugin cannot own that loop: the public plugin API can rewrite
 * the context and observe tool calls, but it has no way to invoke a tool on
 * the model's behalf, so the host's agent loop remains the executor. The
 * action space therefore stays the host's own tools.
 *
 * What the plugin CAN do is the half that produces the paper's O(1) claim —
 * show the model exactly (P, Σₜ, Oₜ) and nothing else — plus the other half
 * of the transition, the WRITE side. The v2 session API has no response hook,
 * but the server's durable event stream publishes `session.text.ended`
 * carrying the completed assistant text block, so the `state_patch` the model
 * emits under the A.4 directive can be parsed and applied to Σₜ. That is a
 * documented public event, not a private channel; see `response-sink.ts`.
 *
 * The two halves together are Algorithm 1's data flow with the host as the
 * executor. Owning the executor end-to-end — including retry-with-rollback
 * and the action being an opaque string the runtime dispatches — requires
 * {@link SkillStateRuntime} with an LLM function and an action executor; see
 * `packages/bench`.
 */

import { PromptTransformer } from '@skillstate/core';
import type {
  Observation,
  ProceduralSpec,
  SkillState,
} from '@skillstate/core';

/** The parts of the host's `context` event this module reads and writes. */
export interface PaperContextEvent {
  messages: Array<{
    id: string;
    role: string;
    content: unknown;
    metadata?: unknown;
  }>;
  system?: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * How the observation was located.
 *
 * Narrower than the core {@link Observation}, whose `source` is a free-form
 * string: this module is the only producer of the observations it consumes,
 * so the three cases it can actually choose are spelled out here and callers
 * get a value they can switch on without re-narrowing.
 */
export type ObservationSource = 'tool' | 'user' | 'empty';

/** The observation this module builds: an {@link Observation} with a known source. */
export type PaperObservation = Observation & { source: ObservationSource };

/** The host message shape produced by {@link applyPaperContext}. */
export interface PaperMessage {
  id: string;
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
  metadata: Record<string, never>;
}

/** Stable id for the synthetic paper prompt, so the host can diff turns. */
export const PAPER_MESSAGE_ID = 'skillstate-paper-prompt';

/** The synthetic id used for the system-fragment preamble. */
const PAPER_PREAMBLE_MARK = '<skillstate-task>';

const transformer = new PromptTransformer();

/**
 * A user message carries text in `content: [{ type: 'text', text }]`.
 * Anything else (a tool result, a media part) is not a task statement.
 */
function textOf(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .filter(
      (part): part is { type: 'text'; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n');
}

/**
 * The user's original request — O₀.
 *
 * The FIRST user text message, not the last. On later steps the most recent
 * user turn is usually a steering message, and pinning the first is what
 * keeps the task present after the transcript has been replaced wholesale.
 * Returns `''` for a session that opened with a system or tool message,
 * which is not a case the paper's setting produces.
 */
export function initialTask(messages: Array<{ role: string; content: unknown }>): string {
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = textOf(message).trim();
    if (text.length > 0) return text;
  }
  return '';
}

/**
 * The latest environment observation — Oₜ.
 *
 * Preference order, and why:
 *
 * 1. the newest TOOL message — that is the result of the previous aₜ, which
 *    is exactly what the paper feeds back;
 * 2. the newest user text turn — at step 0 there is no tool result, and the
 *    request is the observation;
 * 3. `''` — an empty session has no observation, and emitting an empty
 *    "Latest Observation:" line is the faithful rendering of that.
 *
 * `now` stamps {@link Observation.timestamp}. A.4 never renders the
 * timestamp, so it cannot change the prompt; it is set because the core type
 * requires it and because a sink that later needs to order observations has
 * something to order by.
 */
export function latestObservation(
  messages: Array<{ role: string; content: unknown }>,
  now: number = Date.now(),
): PaperObservation {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'tool') {
      return { content: textOf(message).trim(), timestamp: now, source: 'tool' };
    }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === 'user') {
      const text = textOf(message).trim();
      if (text.length > 0) return { content: text, timestamp: now, source: 'user' };
    }
  }
  return { content: '', timestamp: now, source: 'empty' };
}

/**
 * The immutable specification P, with the task pinned as a preamble.
 *
 * A spec is authored before the task is known, so it cannot contain the
 * request. Prepending the task to the instructions keeps it in the model
 * input at every step. The marker makes the block unambiguous and lets a
 * test assert the task is actually present rather than merely intended.
 */
export function proceduralSpecWithTask(
  spec: ProceduralSpec,
  task: string,
): ProceduralSpec {
  if (task.length === 0) return spec;
  return {
    ...spec,
    instructions: `${PAPER_PREAMBLE_MARK}\n${task}\n</skillstate-task>\n\n${spec.instructions}`,
  };
}

/** Options for {@link buildPaperPrompt}. */
export interface PaperPromptOptions {
  spec: ProceduralSpec;
  state: SkillState;
  messages: Array<{ role: string; content: unknown }>;
}

/** What {@link buildPaperPrompt} decided, for tests and diagnostics. */
export interface PaperPrompt {
  /** The A.4 prompt, byte-exact against `PromptTransformer.formatPaper`. */
  prompt: string;
  /** The task pinned into P, `''` when the session has no user turn. */
  task: string;
  /** The observation rendered into the prompt. */
  observation: PaperObservation;
  /** How the observation was obtained. */
  observationSource: ObservationSource;
  /** How many messages the model would have seen before this ran. */
  discardedMessages: number;
}

/**
 * Build the A.4 prompt from the host's transcript.
 *
 * Pure: it reads the messages and returns the prompt plus a description of
 * what it chose, without mutating anything. {@link applyPaperContext} is the
 * half that writes.
 */
export function buildPaperPrompt(options: PaperPromptOptions): PaperPrompt {
  const { spec, state, messages } = options;
  const task = initialTask(messages);
  const observation = latestObservation(messages);
  const effective = proceduralSpecWithTask(spec, task);
  return {
    prompt: transformer.formatPaper(effective, state, observation),
    task,
    observation,
    observationSource: observation.source,
    discardedMessages: messages.length,
  };
}

/**
 * Replace the model-facing context with exactly (P, Σₜ, Oₜ).
 *
 * Two edits, and both are required:
 *
 * - the A.4 prompt becomes the ONLY message, so no reasoning, action or tool
 *   output from earlier steps survives into this dispatch;
 * - the host's own system prompt is REPLACED, not appended to. The paper's P
 *   is the entire instruction surface; leaving the harness's default system
 *   prompt in place would quietly reintroduce behaviour the runtime is
 *   supposed to own (and the default one tells the model to prefer parallel
 *   tool calls, which is incoherent with a single-step state machine).
 *
 * The array is mutated in place: the host keeps the original reference.
 */
export function applyPaperContext(
  event: PaperContextEvent,
  built: PaperPrompt,
  systemPrefix?: string,
): PaperMessage {
  const message: PaperMessage = {
    id: PAPER_MESSAGE_ID,
    role: 'user',
    content: [{ type: 'text', text: built.prompt }],
    metadata: {},
  };
  event.messages.length = 0;
  event.messages.push(message);
  if (event.system !== undefined) {
    const parts = systemPrefix === undefined ? [] : [{ type: 'text', text: systemPrefix }];
    event.system.length = 0;
    event.system.push(...parts);
  }
  return message;
}
