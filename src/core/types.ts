// SkillState - the mutable execution state (Σt in the paper, §3)
export type SkillState = Record<string, unknown>;

// StatePatch - the ΔΣt the LLM produces. Values can be anything or null (for deletion, §3.2)
export type StatePatch = Record<string, unknown | null>;

// Schema field definition
export interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  default: unknown;
  description?: string;
}

// Schema - defines valid state keys and their types
export type StateSchema = Record<string, SchemaField>;

// Procedural specification (P) - immutable skill definition (paper §3.1)
export interface ProceduralSpec {
  id: string;
  name: string;
  instructions: string;
  schema: StateSchema;
  version: string;
}

// Observation (Ot) - latest env observation. The model NEVER receives
// previous observations (§3): only the latest Ot is passed per step.
export interface Observation {
  content: string;
  timestamp: number;
  source?: string;
}

// State transition result
export interface StateTransition {
  previousState: SkillState;
  patch: StatePatch;
  newState: SkillState;
  reasoning: string;
  action: string;
  timestamp: number;
}

// Validation result
export type ValidationResult =
  | { valid: true }
  | { valid: false; error: string; field?: string };

// Execution step record. All sizes are raw string CHARS per paper §4.3
// (Average Prompt Size = mean char length per call) — never tokenizer
// output and never a len/4 estimate.
export interface ExecutionStep {
  step: number;
  observation: Observation;
  reasoning: string;
  statePatch: StatePatch;
  action: string;
  /** Char length of the step's prompt At = (P, Σt, Ot). */
  promptChars: number;
  /** Char length of the raw LLM response(s) for this step. */
  responseChars: number;
  timestamp: number;
  // True when the step's patch was accepted (not exhausted by retries).
  // Feeds Task Accuracy (§4.3); undefined = not actionable (excluded).
  success?: boolean;
}

// Platform adapter interface
export interface PlatformAdapter {
  name: string;
  injectState(state: SkillState, spec: ProceduralSpec): string;
  extractPatch(response: string): StatePatch | null;
  extractAction(response: string): string | null;
  formatPrompt(state: SkillState, observation: Observation, spec: ProceduralSpec): string;
}

// Tracker config
export interface TrackerConfig {
  persistPath?: string;
  sessionName?: string;
  platform: 'claude' | 'opencode' | 'generic';
}
