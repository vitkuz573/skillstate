/**
 * @non-paper Canonical prompt texts — the SINGLE SOURCE OF TRUTH for the
 * {state_patch, action} JSON contract, the history-unreliability hint, the
 * schema renderer, and the SKILL.md body shared by every platform adapter.
 *
 * PROMPT-FIDELITY BOUNDARY: `PromptTransformer.formatPaper` (Appendix A.4)
 * is byte-verbatim paper text and deliberately does NOT use these
 * constants — its inline `{ "state_patch": { <dict: ...> }, "action": ... }`
 * directive differs from the fenced example below by design. Everything
 * here is the @non-paper adapter vocabulary, deduplicated across
 * claude/codex/opencode adapters and the prompt transformer.
 */
import type { ProceduralSpec, StateSchema } from './types.js';

/**
 * The two-key response directive (without the fenced example). Adapters
 * prepend their own lead-in ("Based on your current state, provide your
 * response with:" etc.) and append the numbered items via
 * {@link STATE_PATCH_CONTRACT}.
 */
export const STATE_PATCH_CONTRACT_HEADER =
  'A JSON block containing both your State Patch and your Action. The JSON block MUST have exactly these two keys:';

/** Canonical fenced ```json example block for the two-key contract. */
export const STATE_PATCH_EXAMPLE_JSON = [
  '```json',
  '{',
  '  "state_patch": { "goal": "What this procedure achieves", "obsolete_step": null },',
  '  "action": "your_action_here"',
  '}',
  '```',
].join('\n');

/** Canonical sparse-patch rules: null deletes, omissions leave state unchanged. */
export const STATE_PATCH_RULES =
  'In `state_patch`, set keys to null to delete them. Only include fields you want to change. Omit fields to leave them unchanged.';

/**
 * The reasoning-is-discarded persistence bullet (paper §3.2, §4): any fact
 * that must survive belongs in `state_patch`, never in the conversation.
 */
export const REASONING_DISCARDED_NOTE =
  'Reasoning is discarded after execution — put anything you need to persist into `state_patch`.';

/**
 * The full numbered response contract: reasoning is discarded (paper §3.2),
 * the JSON block carries exactly the two keys, and the patch follows the
 * sparse ⊕ semantics. Includes the example block and the rules — no lead-in.
 */
export const STATE_PATCH_CONTRACT = [
  '1. Step-by-step reasoning (will be discarded after execution)',
  `2. ${STATE_PATCH_CONTRACT_HEADER}`,
  '',
  STATE_PATCH_EXAMPLE_JSON,
  '',
  STATE_PATCH_RULES,
].join('\n');

/**
 * The single history-unreliability hint appended to the additionalContext
 * of every inject-style hook script (claude + codex alike). Names the MCP
 * tools AND the fenced ```json state_patch channel — one text for all
 * hosts, so the Bash-carried patch option can no longer drift away.
 */
export const HISTORY_UNRELIABLE_NOTE =
  '\nHistory is not reliable. Persist anything you need via the skillstate MCP tools (state.summary / state.patch) or a fenced ```json state_patch block.';

/**
 * The interrupted-session hint injected by the SessionStart hooks
 * (claude + codex alike) when the session-meta sidecar carries
 * `status: "interrupted"` — a previous run of this session was killed
 * (SIGINT/SIGTERM) mid-procedure. The hook appends the preserved state
 * path so the agent can review progress/blockers before continuing.
 * A fresh launch overwrites the status back to `running`.
 */
export const INTERRUPTED_SESSION_NOTE =
  '\nPrevious session was interrupted; state preserved at <path>; review progress/blockers before continuing.';

/**
 * Render a state schema as the shared `## Schema` markdown block used by
 * every prompt formatter and adapter `injectState`. Fields without a
 * description fall back to "no description".
 */
export function describeSchema(schema: StateSchema): string {
  const fields = Object.entries(schema)
    .map(
      ([name, field]) =>
        `- ${name} (${field.type}): ${field.description ?? 'no description'}`,
    )
    .join('\n');
  return `## Schema\n${fields}`;
}

/** Options for {@link skillMdBody}. */
export interface SkillMdBodyOptions {
  /** Brand label woven into the hooks intro ("Claude Code", "Codex", "OpenCode"). */
  hostLabel: string;
  /**
   * How the injected state reaches the model, as a predicate:
   * "injected into your context via hooks" (claude) /
   * "provided as developer context" (codex) /
   * "injected into the message list before every model call" (opencode).
   */
  injectionPhrase: string;
  /**
   * The hook names this host wires, verbatim as they appear in the bullets:
   * claude/codex use UserPromptSubmit + `SessionStart` + `PostToolUse`;
   * opencode uses `messages.transform` + `session.compacting` +
   * `tool.execute.after`. The merge-bullet is omitted when `patchHook` is
   * undefined.
   */
  hooks: { inject: string; reInject: string; patchHook?: string };
  /** The skill spec — name/instructions/version fill the frontmatter. */
  spec: ProceduralSpec;
  /** State path written into the frontmatter and the body (default `./.skillstate/skillstate.json`). */
  statePath?: string;
}

/**
 * Generate the whole SKILL.md document shared by the hook-wiring adapters
 * (claude, codex): identical frontmatter, Execution Context, and Process
 * sections; the ONLY brand-specific parts are `hostLabel` (hooks intro)
 * and `injectionPhrase` (how the state reaches the model). OpenCode keeps
 * its own body — its history is trimmed by the plugin, not by hooks, so
 * its Execution Context and Process genuinely differ.
 *
 * HOOK-NEUTRAL: the injected bullets are driven by `options.hooks` so ANY
 * harness (claude/codex hook-wiring, opencode plugin transforms) renders the
 * same canonical Process without forking the body.
 */
export function skillMdBody(options: SkillMdBodyOptions): string {
  const resolvedStatePath = options.statePath ?? './.skillstate/skillstate.json';
  const patchHook = options.hooks.patchHook;
  const body = [
    '---',
    `name: ${JSON.stringify(options.spec.name)}`,
    `description: ${JSON.stringify(options.spec.instructions)}`,
    `version: ${options.spec.version}`,
    'execution_context:',
    `  state_path: ${resolvedStatePath}`,
    '  format: json',
    '---',
    '',
    `# ${options.spec.name}`,
    '',
    options.spec.instructions,
    '',
    '## Execution Context',
    '',
    `Your execution state lives at \`${resolvedStatePath}\` (per project; a`,
    'session started in $HOME uses `~/.skillstate/global/skillstate.json`).',
    `The skillstate ${options.hostLabel} integration:`,
    '',
    `- the CURRENT state is ${options.injectionPhrase} on every prompt submit`,
    `  (\`${options.hooks.inject}\`) and is re-injected after compaction`,
    `  (\`${options.hooks.reInject}\`);`,
  ];
  if (patchHook !== undefined) {
    body.push(
      '- watch every Bash tool result and merge a fenced ```json block carrying',
      `  a \`state_patch\` into the state file (\`${patchHook}\`).`,
    );
  }
  body.push(
    '',
    'Sub-agents automatically get isolated state copies (agents/<session-id>);',
    'merge them with `agent.merge` when their task completes.',
    '',
    'The injected state is authoritative — history is not reliable. Never',
    'reconstruct execution context from the conversation.',
    '',
    '## Process',
    '',
    '1. Orient yourself: read the injected state, or call the skillstate MCP',
    '   tools `state.summary` (compact) / `state.get` (full dump).',
    '2. Observe the result of your last action.',
    '3. Reason about what to do next, given the state and the observation.',
    '4. Persist progress with the skillstate MCP tool `state.patch` (sparse',
    '   patch; set a key to `null` to delete it; dry-run first with',
    '   `state.validate` when unsure; `state.diff` shows what changed since',
    '   your last look)',
  );
  if (patchHook !== undefined) {
    body.push(
      '   , and/or emit a fenced JSON block with exactly two',
      '   keys inside a Bash tool call so the `PostToolUse` hook merges it:',
      '',
      STATE_PATCH_EXAMPLE_JSON,
      '',
      `- ${STATE_PATCH_RULES}`,
    );
  } else {
    body.push(':', '', STATE_PATCH_EXAMPLE_JSON, '', `- ${STATE_PATCH_RULES}`);
  }
  body.push(
    '- Put anything you need to survive into `state_patch`; never rely on',
    '  the conversation remembering it.',
    '- `action` names what you will do next (e.g. "continue", "done").',
    '- When the task is done, call state.finalize {status:"completed"} so the',
    '  orchestrator knows (state.finalize {status:"failed"} on failure).',
    '',
  );
  return body.join('\n');
}
