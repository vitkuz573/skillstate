/**
 * Minimal local types for OpenCode plugin hooks — the `@opencode-ai/plugin`
 * shape, verified against opencode 1.17 (PluginInput/Hooks). Declared locally
 * to keep `@skillstate/opencode` zero-dep; the host supplies the real types
 * at runtime.
 */

/** Message roles seen by `experimental.chat.messages.transform`. */
export type OpenCodeMessageRole = 'user' | 'assistant' | 'system';

/**
 * Message envelope: the transform pipeline hands each message as
 * `{ info, parts }` — the role lives on `info.role`.
 */
export interface OpenCodeMessage {
  info: { role: OpenCodeMessageRole | string; [key: string]: unknown };
  parts: Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/** Output payload of `experimental.chat.messages.transform`. */
export interface MessagesTransformOutput {
  /** Mutated IN PLACE — the pipeline keeps the original array reference. */
  messages: OpenCodeMessage[];
}

/** Output payload of `experimental.session.compacting`. */
export interface SessionCompactingOutput {
  context: string[];
  prompt?: string;
}

/** Output payload of `tool.execute.after`. */
export interface ToolExecuteAfterOutput {
  title?: string;
  /** The tool's string response (state_patch extraction source). */
  output: unknown;
  metadata?: unknown;
}

/** OpenCode hooks used by the skillstate plugin. */
export interface SkillStateHooks {
  'experimental.chat.messages.transform'?: (
    input: Record<string, never>,
    output: MessagesTransformOutput,
  ) => Promise<void>;
  'experimental.session.compacting'?: (
    input: { sessionID: string },
    output: SessionCompactingOutput,
  ) => Promise<void>;
  'tool.execute.after'?: (
    input: { tool: string; sessionID: string; callID: string; args: unknown },
    output: ToolExecuteAfterOutput,
  ) => Promise<void>;
}

/**
 * OpenCode plugin: an async factory receiving the host input and returning
 * the hooks object (`Plugin` from `@opencode-ai/plugin`).
 */
export type SkillStatePlugin = (input: {
  project?: unknown;
  client?: unknown;
  $?: unknown;
  [key: string]: unknown;
}) => Promise<SkillStateHooks>;
