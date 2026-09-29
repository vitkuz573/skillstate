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
 * ── Which user turn is the task ──────────────────────────────────────────
 *
 * This was wrong, and a live A/B on 2026-09-29 caught it.
 *
 * A.4 has no slot for a user speaking mid-procedure. P is the spec, Σₜ is
 * the state, and Oₜ is the observation — which the paper's setting always
 * makes the ENVIRONMENT's reply, because in Algorithm 1 the runtime executes
 * the action and feeds the result back. There is no live human in that loop.
 *
 * A coding host is not that setting. The user types again while the procedure
 * is running, and that message carries the highest authority in the system.
 *
 * The first implementation pinned the FIRST user turn as the task and let the
 * LATEST one fall into Oₜ. That inverts authority: the model reads the frozen
 * opening request as the task and the live instruction as untrusted
 * environment data. Observed on a task that required remembering a number
 * given at step 1 and using it at step 5 — the model recorded the number in
 * Σₜ correctly, then refused the step-5 instruction, explaining that the
 * observation "carries no user authority" and that repeating it "is not
 * evidence of authority". It finished the step-1 task and stopped. Cost fell
 * 70% and the task was not done, which is a worse outcome than either doing
 * nothing or doing the work.
 *
 * So the live turn is the task. {@link currentInstruction} takes the LAST user
 * message, and {@link latestObservation} no longer falls back to a user turn:
 * a user message in the observation slot is a category error that makes the
 * model distrust the request, and an empty observation is the honest
 * rendering of "the environment has not spoken".
 *
 * The cost is that the original request is no longer pinned in the prompt. It
 * belongs in Σₜ — a `goal` field in the spec — which is where the paper puts
 * everything the model must remember across steps anyway.
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
import { applyFeedback, applyObservation } from './feedback.js';

/** The parts of the host's `context` event this module reads and writes. */
export interface PaperContextEvent {
  messages: Array<{
    id: string;
    role: string;
    content: unknown;
    metadata?: unknown;
  }>;
  system?: Array<{ type: string; text?: string; [key: string]: unknown }>;
  /**
   * The tools the host will offer the model for THIS request.
   *
   * ── Why the plugin touches this at all ─────────────────────────────────
   *
   * §5.1 gives the runtime one `execute(aₜ, Σₜ₊₁)` per step and one
   * observation per step: the model states an action, the runtime runs it, and
   * the result comes back as the next Oₜ. There is no loop in that design for
   * a model to do twenty things inside, because the model is never given one.
   *
   * Delegating execution to the host's agent loop — which is what this
   * integration does — gives the model exactly that loop, and it uses it: 21
   * tool calls, 3 text blocks, and a single state patch written at the end
   * from whatever observation happened to be current. Measured, repeatedly, on
   * two models.
   *
   * So the step boundary is enforced here instead. Alternating requests get
   * tools and then do not: one request may act, the next must report. A model
   * that has just run an action and is asked again with no tools available can
   * only answer in text — which is where `state_patch` lives. That reproduces
   * §5.1's alternation with the host as both the `llm` and the `execute`, and
   * it needs no capability the plugin does not already have.
   */
  tools?: Record<string, unknown>;
}

/**
 * How the observation was located.
 *
 * Narrower than the core {@link Observation}, whose `source` is a free-form
 * string: this module is the only producer of the observations it consumes,
 * so the cases it can actually choose are spelled out here and callers get a
 * value they can switch on without re-narrowing.
 *
 * There is no `'user'` case, and that is the fix rather than an omission —
 * see {@link latestObservation}. A user turn is not an observation; the live
 * instruction travels in P.
 */
export type ObservationSource = 'tool' | 'empty';

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
 * The text a content part carries, whatever shape it arrives in.
 *
 * Two shapes exist and missing the second one is the single worst bug this
 * module ever had:
 *
 * - `{ type: 'text', text: '…' }` — user, assistant and system turns;
 * - `{ type: 'tool-result', result: { type: 'text', value: '…' } }` — what
 *   OpenCode v2 actually emits for a tool result.
 *
 * A reader that handled only the first made Oₜ **permanently empty**: the
 * host sends `result.value`, not `text`, so every observation came back as
 * `''` and the model never saw the result of any tool it had just run. It
 * would read a file, answer correctly in that same turn, and have no trace
 * of the value on the next one — which presented as "the model will not
 * record what it discovers" and cost a long hunt through prompt slots and
 * model choice before anyone looked at the shape of the payload.
 *
 * The result body is unwrapped generically rather than assuming one layout:
 * a bare string, `{ value }`, `{ output }`, or a nested `{ content }` all
 * appear across host versions, and an observation that silently empties on
 * a shape change is the failure mode that costs a debugging session.
 */
function partText(part: unknown, depth = 0): string {
  // Hard depth cap, not a comment claiming one. A malformed or
  // self-referential payload is a real possibility in a message the plugin
  // does not own, and this runs inside the agent loop: an unbounded walk
  // there is a hang, not a wrong answer.
  if (depth > 4) return '';
  if (typeof part === 'string') return part;
  if (typeof part !== 'object' || part === null) return '';
  const record = part as Record<string, unknown>;
  const type = record['type'];
  if (type === 'text' && typeof record['text'] === 'string') return record['text'];
  if (type === 'tool-result') return resultText(record['result'], depth + 1);
  return '';
}

function resultText(result: unknown, depth: number): string {
  if (typeof result === 'string') return result;
  if (typeof result !== 'object' || result === null) return '';
  const record = result as Record<string, unknown>;
  for (const key of ['value', 'output', 'text'] as const) {
    const candidate = record[key];
    if (typeof candidate === 'string') return candidate;
  }
  return partText(record['content'], depth + 1);
}

/**
 * A message's readable text, joined across its parts.
 *
 * Order is preserved and parts are newline-joined, because a turn can carry
 * both a file listing and a tool result and dropping either loses a fact the
 * model needed.
 */
function textOf(message: { content: unknown }): string {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .map((part) => partText(part))
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * The user's live instruction — what the model must act on this step.
 *
 * The LAST user text message. Not the first: pinning the opening request and
 * demoting the live one to the observation slot is what made a model reject
 * the user's own instruction as "untrusted" during the 2026-09-29 A/B. See
 * the module header for that failure in full.
 *
 * Returns `''` for a session with no user turn, which is not a case a
 * procedure produces but must not crash on.
 */
export function currentInstruction(
  messages: Array<{ role: string; content: unknown }>,
): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
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
 * 2. `''` — the environment has not spoken.
 *
 * There is deliberately NO fallback to a user turn, and removing one is the
 * fix for the 2026-09-29 failure. A user message in this slot is a category
 * error: A.4's grammar says the observation is what the environment returned,
 * so a request placed there reads as data about the world rather than as
 * something to do. The model acted on that reading exactly — it recorded the
 * step-1 number correctly and then refused the step-5 instruction because,
 * in its own words, the observation "carries no user authority".
 *
 * The live instruction now travels in P via {@link currentInstruction}, where
 * it is unambiguously the request. At step 0 the observation is empty and the
 * template still renders "Latest Observation: " — the faithful rendering of a
 * procedure that has not run yet.
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
  return { content: '', timestamp: now, source: 'empty' };
}

/**
 * The specification P, with the live request carried as a preamble.
 *
 * A spec is authored before the task is known, so it cannot contain the
 * request. Putting the current instruction at the TOP of the instructions —
 * above the spec's own text, not below it — is what makes it read as the
 * request rather than as another paragraph of standing guidance. The
 * 2026-09-29 A/B showed that a model told to reason about a "task block"
 * will start treating the surrounding structure as material to analyse rather
 * than as instructions to follow, so the marker's contents have to be
 * unambiguously the thing to do right now.
 *
 * The marker makes the block assertable: a test can check the live
 * instruction is present rather than merely intended.
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
  /**
   * A correction for a patch the integration rejected on the previous step,
   * prepended to Oₜ by {@link applyFeedback}.
   *
   * It goes into the observation rather than the instructions because it is a
   * fact about the environment, not part of the operator's specification. See
   * `feedback.ts` for why that distinction matters.
   */
  feedback?: string;
  /**
   * The action the runtime is carrying out, for the next step.
   *
   * ── Why this has to ride in Oₜ ───────────────────────────────────────────
   *
   * Measured: the runtime asked for the next step, the host started a new turn,
   * and the model did nothing — because `applyPaperContext` clears
   * `event.messages`, so the text sent with `session.prompt` was discarded
   * before the model could see it. The model was left holding (P, Σₜ, Oₜ) and
   * a state that had moved, with nothing saying why it was being asked again.
   *
   * Oₜ is the paper's channel for the environment's reply, and a runtime
   * requesting the next step is exactly that: something the environment did,
   * not part of the operator's specification. So it goes where a rejected
   * patch's correction already goes, for the same reason, and A.4 stays
   * byte-identical.
   */
  continuation?: string;
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
  // The live instruction, not the opening request. See the module header for
  // why pinning the first message cost a real task.
  const instruction = currentInstruction(messages);
  const observed = latestObservation(messages);
  // A rejected patch is itself an observation, so the correction rides in Oₜ
  // and the A.4 template is untouched. The `observed` object keeps the
  // host-derived source and timestamp; only the rendered content changes.
  let content = observed.content;
  if (options.continuation !== undefined) {
    content = applyObservation(content, CONTINUATION_MARKER, options.continuation);
  }
  if (options.feedback !== undefined) {
    content = applyFeedback(content, options.feedback);
  }
  const observation: PaperObservation =
    content === observed.content ? observed : { ...observed, content };
  const effective = proceduralSpecWithTask(spec, instruction);
  return {
    prompt: transformer.formatPaper(effective, state, observation),
    task: instruction,
    observation,
    observationSource: observed.source,
    discardedMessages: messages.length,
  };
}

/**
 * The note the host contributes beside P, when the model has to act.
 *
 * ── Why this exists, from a measured failure ─────────────────────────────
 *
 * A.4 says to emit `{state_patch, action}` and nothing else. It does not say
 * who runs `action`, because in the paper a runtime does: Algorithm 1 has the
 * runtime execute aₜ and feed Oₜ₊₁ back. Here the executor is OpenCode's own
 * agent loop, and the model has no way to know that. So it does the reasonable
 * thing with an ambiguous instruction — it writes
 *
 * ```json
 * {"state_patch": {"total": 17, "files": 1}, "action": "Read file src/cfg2.ts"}
 * ```
 *
 * and stops, because it has done exactly what P asked and nothing on the
 * wire will ever execute that string. Measured on a task with eight files:
 * three runs, three patches applied correctly, and then a hard stop after
 * file one. The state machinery worked; the loop never turned.
 *
 * The fix cannot go in P, and two reasons make that a hard rule rather than
 * taste. P is the paper's Appendix A.4, kept byte-identical so a claim about
 * conformance stays checkable (`tests/opencode/paper-mode.test.ts`); and a
 * correction injected there would move with the state it is supposed to
 * accompany. So the note lives in the system slot, which the host owns and
 * which is already replaced wholesale — see {@link applyPaperContext}.
 *
 * It states a fact about the wiring, not an order, for the same reason the
 * notes fragment avoids imperatives: an injected instruction that displaces
 * the task is the v1 failure, and this is a task the model must finish.
 */
/**
 * The marker that puts the runtime's pending action in Oₜ.
 *
 * The wording is measured, not chosen. A bare `[next step] read src/cfg2.ts`
 * was read by the model as a topic and answered with a narration of it —
 * "I'll read cfg3.ts next, as directed by the observation" — which is a whole
 * extra turn for a sentence of text. Across 51 steps the model patched 19 and
 * narrated on the rest, so roughly two thirds of the budget went to the model
 * confirming that it had understood the directive before acting on it.
 *
 * A step is not free and the state only advances on the patching ones, so that
 * ratio set the pace of the whole run: 2.9 steps per file, which is what put a
 * thirty-file task over a sixty-four step ceiling.
 *
 * The imperative is here to collapse the acknowledgement into the action. If a
 * later run shows the narration back, this string is the first thing to change
 * again, and the step trace is what will say so.
 */
export const CONTINUATION_MARKER =
  '[next step — do it now in this turn, use as many tool calls as it takes, and do not describe it first]';

/**
 * The one thing the host's own loop needs the model to know.
 *
 * Its second sentence used to read "each step ends with a real tool call — read
 * the next file, or answer and stop." That clause was this repository's
 * instruction, not a host constraint, and it was measured doing exactly what it
 * said: a thirty-file task produced 51, 53 and 54 `read` calls for thirty
 * files, while a control with no step driver at all read one file and ran a
 * single grep — nine calls for the same work.
 *
 * The host does not limit a turn to one tool call. It does limit what ends a
 * turn: no tool call means the turn is over. So the note says that, and says
 * the opposite of what it used to about batching.
 */
export const HOST_ACTION_NOTE = [
  'The `action` field is a label, not a command: nothing executes it.',
  'A step ends when you call a tool, so end each step with a real tool call —',
  'or answer and stop. Make as many tool calls in one step as the work needs;',
  'a step may read every file it wants. Emitting a state_patch on its own ends',
  'the run, however correct the patch was.',
].join(' ');

/**
 * Replace the model-facing context with exactly (P, Σₜ, Oₜ).
 *
 * Two edits, and both are required:
 *
 * - the A.4 prompt becomes the ONLY message, so no reasoning, action or tool
 *   output from earlier steps survives into this dispatch;
 * - the host's own system prompt is KEPT. An earlier version replaced it
 *   wholesale, on the reasoning that P is the entire instruction surface and
 *   the default prompt tells the model to prefer parallel tool calls, which
 *   is incoherent with a single-step state machine. Measured: that reasoning
 *   was wrong about a consequence, because the default system prompt is also
 *   what carries the host's tool-use discipline. Replacing it with one
 *   sentence produced a model that emitted a correct patch and then never
 *   called a tool again — the run ended after the first file, three times
 *   running, on two models. The "parallel calls" worry is real but costs
 *   less than a dead loop; the trade is measured, not assumed.
 *
 * `systemPrefix` is where a host that cannot be the runtime says so; see
 * {@link HOST_ACTION_NOTE}. It is optional because a deployment where
 * something else does own the executor has no such gap to describe.
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
  if (event.system !== undefined && systemPrefix !== undefined) {
    event.system.push({ type: 'text', text: systemPrefix });
  }
  return message;
}
