/**
 * The A/B harness: a run record per trial, and gates on the result.
 *
 * Everything here is either pure or injected. The live driver
 * (`run-live.ts`) supplies the I/O; the gates in `verdict.ts` and the
 * statistics in `stats-core.ts` never touch a filesystem or a clock, which
 * is what allows them to be tested against the real historical numbers.
 *
 * @non-paper — measurement infrastructure, not the paper's evaluation.
 */

export {
  ARM_IDS,
  CONTROL_ENGAGEMENT,
  buildArmRecord,
  isInstrumented,
  promptTokens,
} from './record.js';
export type {
  ArmId,
  ArmRecord,
  EngagementEvidence,
  RunRecord,
  TokenUsage,
  WorkEvidence,
} from './record.js';

export {
  MIN_EFFECT_IN_MADS,
  describe,
  effectSize,
  mad,
  median,
  relativeMad,
} from './stats-core.js';
export type { Distribution, EffectSize } from './stats-core.js';

export { MIN_TRIALS, runExperiment } from './verdict.js';
export type {
  ExperimentOptions,
  GateFailure,
  Verdict,
  VerdictResult,
} from './verdict.js';

export { assessEngagement, isWitnessed, withRejections } from './engagement.js';
export type { EngagementReport, StateSample } from './engagement.js';

export { NO_USAGE, resolveSessionUsage, sessionUsage } from './usage.js';
export type {
  HostMessageRow,
  UsageFailure,
  UsageOutcome,
  UsageReader,
} from './usage.js';

export { formatArmTable, formatVerdict } from './report.js';

export { serverSessionUsage, serverUsageReader } from './opencode-usage.js';
export type { ServerFetcher } from './opencode-usage.js';

export { DEFAULT_BOUNDED_PROMPT_TOKENS, assessReconstruction, promptTokensOf, reconstruct } from './replay.js';
export type { HostSession, ReconstructOptions, ReconstructResult, StepUsage } from './replay.js';

export { breakEvenPromptTokens, formatSurvey, survey } from './survey.js';
export type { Survey, SurveyOptions } from './survey.js';
