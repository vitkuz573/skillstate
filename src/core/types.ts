// SkillState - the mutable execution state (Σt in the paper)
export type SkillState = Record<string, unknown>;

// StatePatch - the ΔΣt the LLM produces. Values can be anything or null (for deletion)
export type StatePatch = Record<string, unknown | null>;

// Schema field definition
export interface SchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  default: unknown;
  description?: string;
}

// Schema - defines valid state keys and their types
export type StateSchema = Record<string, SchemaField>;

// Procedural specification (P) - immutable skill definition
export interface ProceduralSpec {
  id: string;
  name: string;
  instructions: string;
  schema: StateSchema;
  version: string;
}

// Observation (Ot) - latest env observation
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

// Token savings metrics
export interface TokenSavings {
  promptReduction: number;
  cumulativeSavings: number;
  savingsPercent: number;
  historyTokens: number;
  stateTokens: number;
}

// Execution step record
export interface ExecutionStep {
  step: number;
  observation: Observation;
  reasoning: string;
  statePatch: StatePatch;
  action: string;
  tokensUsed: number;
  promptSize: number;
  timestamp: number;
  // True when the step's patch was accepted (not exhausted by retries)
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
