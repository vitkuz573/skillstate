/**
 * `@skillstate/opencode` — the OpenCode v2 plugin package.
 *
 * The default export IS the plugin definition: OpenCode loads
 * `opencode.json` → `"plugins": ["@skillstate/opencode"]`, imports this
 * module and calls `setup(ctx)`. Everything else is exported for tests and
 * for embedders that want the pieces without the plugin lifecycle.
 *
 * See `plugin.ts` for the design contract, in particular that notes mode
 * (the default) never mutates `event.messages`.
 */

export { SkillStatePlugin, PLUGIN_ID, default } from './plugin.js';
/**
 * The paper-exact `PlatformAdapter` (arXiv 2608.26263v3 A.4 prompt format).
 * Kept as the research surface used by the benchmark; it is NOT the host
 * integration and nothing in the plugin path calls it. In particular its
 * `injectState` still emits the paper's `STATE_PATCH_CONTRACT`, which is
 * exactly the instruction pattern the v2 plugin avoids.
 */
export { OpenCodeAdapter } from './opencode-adapter.js';
export {
  SessionRegistry,
  stateScopeFor,
  DEFAULT_SESSION_TTL_MS,
} from './session-registry.js';
export type { SessionRecord, SessionRegistryOptions } from './session-registry.js';
export {
  ProjectStateStore,
  diffDocuments,
  mergeDocuments,
  statePathFor,
} from './state-store.js';
export type {
  StateChanges,
  StateDocument,
  ProjectStateStoreOptions,
} from './state-store.js';
export {
  buildStateHint,
  renderStateForHint,
  ADVERTISED_TOOLS,
  MAX_INLINE_STATE_CHARS,
} from './system-hint.js';
export type { StateHintOptions } from './system-hint.js';
export { registerTools, normalizePatch, MAX_PATCH_BYTES } from './tools.js';
export type {
  MergeValue,
  ReadValue,
  ToolDeps,
  ToolError,
  ToolOk,
  ToolResult,
  UpdateValue,
} from './tools.js';
/**
 * Paper mode — the A.4 context replacement. Pure functions plus the two
 * halves of the write (`buildPaperPrompt` reads, `applyPaperContext`
 * writes); the plugin composes them in `plugin.ts`.
 */
export {
  PAPER_MESSAGE_ID,
  applyPaperContext,
  buildPaperPrompt,
  currentInstruction,
  latestObservation,
  proceduralSpecWithTask,
} from './paper-mode.js';
export type {
  ObservationSource,
  PaperContextEvent,
  PaperMessage,
  PaperObservation,
  PaperPrompt,
  PaperPromptOptions,
} from './paper-mode.js';
/** The Σₜ sink that closes the paper transition in the OpenCode host. */
export { DEFAULT_DEDUPE_CAPACITY, PaperStateSink, isTextEnded } from './response-sink.js';
export type { PaperStateSinkOptions, SinkOutcome, SinkRejection } from './response-sink.js';
/** Corrective feedback for a rejected patch, carried in the A.4 observation. */
export { FeedbackQueue, applyFeedback, feedbackFor } from './feedback.js';
export type { PendingFeedback } from './feedback.js';
/** Mode resolution — `SKILLSTATE_MODE` over `skillstate.json` over default. */
export {
  DEFAULT_PLUGIN_MODE,
  MODE_ENV_VAR,
  PLUGIN_MODES,
  asPluginMode,
  resolvePluginMode,
} from './mode.js';
export type { ModeResolution, ModeSource, PluginMode, ResolveModeOptions } from './mode.js';
/** Resolving P for paper mode. */
export { SPEC_FILE_NAME, SpecResolver, parseSpec } from './spec-loader.js';
export type { SpecResolution, SpecSource } from './spec-loader.js';
