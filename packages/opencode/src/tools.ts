/**
 * Native OpenCode tools for skillstate.
 *
 * These are the NATIVE tools: the fast path when the host is opencode v2.
 * They carry a real JSON Schema and structured output, where the MCP server
 * (`@skillstate/mcp`, still shipped and still registered) can only offer a
 * JSON-RPC round-trip and untyped text. Both read the same state file, so
 * the choice between them is about speed and typing on one side and reach
 * on the other -- never about which one is correct.
 *
 * The MCP server was once the ONLY option: an opencode v1 plugin could not
 * contribute first-class tools at all.
 *
 * Three tools, deliberately:
 *
 * - `skillstate_read`   - what this session has already saved.
 * - `skillstate_update` - merge a patch (the only write path).
 * - `skillstate_merge`  - fold sub-agent notes back into the root session.
 *
 * A fourth "delete everything" tool is intentionally absent: `null` in a
 * patch already deletes a key, and a tool whose only job is to erase state
 * is a foot-gun with no upside.
 *
 * ── Result shape ──────────────────────────────────────────────────────────
 *
 * Every tool returns a DISCRIMINATED result: `{ ok: true, ... }` or
 * `{ ok: false, error }`. This is not a stylistic choice. A tool that
 * declares an `output` schema must return a value matching it, so a failure
 * path that returned only text was rejected by the host with "tool did not
 * return its declared output" — a rejected tool call is worse for the agent
 * than a failed one, because it loses the reason. A validation failure is a
 * normal outcome here, and it is modelled as one.
 *
 * SCOPING is automatic. The current session's scope comes from
 * `ToolContext.sessionID` plus the {@link SessionRegistry}, so the model
 * never passes a session id and can never write another agent's file by
 * guessing one.
 */

import type { ToolContext, ToolEditor } from '@opencode/plugin/promise/tool';
import { validatePatch } from '@skillstate/core';
import type { SkillState, StatePatch, StateSchema } from '@skillstate/core';
import type { SessionRegistry } from './session-registry.js';
import { stateScopeFor } from './session-registry.js';
import type { ProjectStateStore, StateChanges } from './state-store.js';

/**
 * Largest serialized patch a single `skillstate_update` accepts. The state
 * file is a side channel for a human to read; a model that tries to dump a
 * whole file into it should be told, not silently accommodated.
 */
export const MAX_PATCH_BYTES = 64 * 1024;

/** A tool call that succeeded. */
export interface ToolOk<T> {
  readonly ok: true;
  readonly value: T;
}

/** A tool call that was refused. `error` is written for the model to read. */
export interface ToolError {
  readonly ok: false;
  readonly error: string;
}

/** Every tool result is one of these two. */
export type ToolResult<T> = ToolOk<T> | ToolError;

/** Payload of a successful `skillstate_read`. */
export interface ReadValue {
  readonly state: Record<string, unknown>;
  readonly path: string;
  readonly scope: string;
  readonly empty: boolean;
}

/** Payload of a successful `skillstate_update`. */
export interface UpdateValue {
  readonly state: Record<string, unknown>;
  readonly changes: StateChanges;
  readonly path: string;
  readonly scope: string;
}

/** Payload of a successful `skillstate_merge`. */
export interface MergeValue {
  readonly state: Record<string, unknown>;
  readonly changes: StateChanges;
  readonly merged: readonly string[];
  readonly skipped: readonly string[];
}

/** Everything the tool definitions need, bound to one plugin instance. */
export interface ToolDeps {
  readonly store: ProjectStateStore;
  readonly sessions: SessionRegistry;
  /** Resolve a session id to its state scope; `''` is the root session. */
  scopeFor: (sessionID: string) => string;
  /**
   * The project's declared schema, when it SHIPPED one.
   *
   * `undefined` is the normal case and the correct one: §6.2 validates
   * `ΔΣ_t` against `P.schema`, so there is nothing to check a patch against
   * for a project that has not declared a schema, and inventing a default here
   * would reject notes that are perfectly reasonable.
   *
   * It is passed because this tool is the same file the paper's Σ lives in, and
   * §9.3 says "a conforming writer must never emit a `state` containing a key
   * absent from the schema". Measured: a notes-mode run called this tool
   * thirty-one times from inside the host's `execute` sandbox, and the state
   * file ended with a `last` key that the schema does not declare — accepted,
   * `ok: true`, and written by an unvalidated second writer into the same
   * document the paper's runtime owns. Only a spec the project SHIPPED is used,
   * for the same reason `declaredFields` is gated on the source: announcing our
   * own fallback schema as the project's would be a false claim.
   */
  readonly schema?: StateSchema;
  /**
   * Called after a patch is written, with the scope it was written to.
   *
   * The drift counter resets on it, and the counter is what the system prompt
   * says out loud: "this state file has not changed across the last N steps of
   * work". So it has to be reset by *every* write path, not just the one the
   * paper-mode sink owns.
   *
   * Measured: in notes mode there is no sink, `stateWrites` never increments and
   * `turnsSinceWrite` is never reset — so the notice fires at its threshold and
   * reports silence for a run in which the model wrote the state on every step.
   * The drift measurement that "the notice does not work" rested on was reading
   * a counter that could not see the writes it was counting.
   */
  readonly onWrite?: (scope: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Result plumbing                                                    */
/* ------------------------------------------------------------------ */

/** Wrap a successful payload in the tool result envelope. */
function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

/** Wrap a refusal in the tool result envelope. */
function refuse<T>(error: string): ToolResult<T> {
  return { ok: false, error };
}

/**
 * Render a result as the host-facing tool result.
 *
 * `content` carries the same JSON so the model reads a stable shape whether
 * or not the host surfaces `output` — and a refusal states its reason in
 * plain text rather than burying it in a shape the model must parse.
 */
function render<T>(result: ToolResult<T>): { output: ToolResult<T>; content: string } {
  if (result.ok) {
    return { output: result, content: JSON.stringify(result.value, null, 2) };
  }
  return { output: result, content: result.error };
}

/* ------------------------------------------------------------------ */
/*  Schemas                                                            */
/* ------------------------------------------------------------------ */

function object(
  properties: Record<string, unknown>,
  required: readonly string[] = [],
): Record<string, unknown> {
  return {
    type: 'object',
    properties,
    required: [...required],
    additionalProperties: false,
  };
}

/** The state document: a free-form JSON object. */
const STATE = { type: 'object', additionalProperties: true } as const;

const STRING_ARRAY = { type: 'array', items: { type: 'string' } } as const;

/** The change sets a patch or merge reports. */
const CHANGES = object(
  { added: STRING_ARRAY, updated: STRING_ARRAY, deleted: STRING_ARRAY },
  ['added', 'updated', 'deleted'],
);

/**
 * Build an `output` schema for a result whose success payload is `value`.
 *
 * The `ok` discriminator is the only required key, so a refusal validates
 * exactly as well as a success does — the shape the host checks is the
 * shape every call actually returns.
 */
function outputSchema(value: Record<string, unknown>): Record<string, unknown> {
  return object(
    {
      ok: { type: 'boolean' },
      value: value,
      error: { type: 'string' },
    },
    ['ok'],
  );
}

const READ_OUTPUT = outputSchema(
  object({ state: STATE, path: { type: 'string' }, scope: { type: 'string' }, empty: { type: 'boolean' } }, [
    'state',
    'path',
    'scope',
    'empty',
  ]),
);

const UPDATE_OUTPUT = outputSchema(
  object(
    { state: STATE, changes: CHANGES, path: { type: 'string' }, scope: { type: 'string' } },
    ['state', 'changes', 'path', 'scope'],
  ),
);

const MERGE_OUTPUT = outputSchema(
  object(
    {
      state: STATE,
      changes: CHANGES,
      merged: STRING_ARRAY,
      skipped: STRING_ARRAY,
    },
    ['state', 'changes', 'merged', 'skipped'],
  ),
);

/* ------------------------------------------------------------------ */
/*  Input handling                                                     */
/* ------------------------------------------------------------------ */

/** JSON guard: a usable top-level object value. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Narrow a tool's `input`.
 *
 * A tool declared with a JSON Schema is validated by the host before
 * `execute` runs, so the parameter arrives typed `unknown` and narrowing it
 * here is the honest boundary rather than a cast. Unknown keys are dropped
 * instead of forwarded, so a model that invents a field cannot smuggle it
 * into the patch. The host check is not sufficient on its own: it cannot
 * see a byte budget, and JSON Schema does not describe "no undefined".
 */
function readInput<T extends object>(
  input: unknown,
  guard: (raw: Record<string, unknown>) => T,
): T {
  if (!isPlainObject(input)) return guard({});
  return guard(input);
}

/** Reader for `skillstate_read`: an optional sub-agent scope. */
function readReadInput(input: unknown): { scope?: string } {
  return readInput(input, (raw) => {
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    return scope.length > 0 ? { scope } : {};
  });
}

/** Reader for `skillstate_update`: the required patch. */
function readUpdateInput(input: unknown): { patch: unknown } {
  return readInput(input, (raw) => ({ patch: raw['patch'] }));
}

/** Reader for `skillstate_merge`: optional scope and keep policy. */
function readMergeInput(input: unknown): { scope?: string; keep: 'existing' | 'source' } {
  return readInput(input, (raw) => {
    const scope = typeof raw['scope'] === 'string' ? raw['scope'].trim() : '';
    return {
      ...(scope.length > 0 ? { scope } : {}),
      keep: raw['keep'] === 'source' ? 'source' : 'existing',
    };
  });
}

/**
 * Validate and normalize an incoming patch.
 *
 * Returns either the patch or a human-readable reason it was rejected. The
 * checks protect the file; they do not dictate the model's schema. A state
 * note is free-form by design, so the only hard rules are "must be an
 * object", "must be JSON-serializable", and "must fit".
 */
export function normalizePatch(
  raw: unknown,
): { ok: true; patch: StatePatch } | { ok: false; reason: string } {
  if (!isPlainObject(raw)) {
    return {
      ok: false,
      reason: '`patch` must be a JSON object, for example {"decisions": ["..."]}.',
    };
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key.length === 0) {
      return { ok: false, reason: '`patch` contains an empty key.' };
    }
    if (value === undefined) {
      return {
        ok: false,
        reason: `\`${key}\` is undefined - omit the key instead, or set it to null to delete it.`,
      };
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return {
      ok: false,
      reason:
        '`patch` is not JSON-serializable - use plain objects, arrays, strings, numbers, booleans and null.',
    };
  }
  const bytes = Buffer.byteLength(serialized, 'utf-8');
  if (bytes > MAX_PATCH_BYTES) {
    return {
      ok: false,
      reason: `\`patch\` is ${bytes} bytes, over the ${MAX_PATCH_BYTES}-byte limit. Keep file contents in the repository instead and save only the path.`,
    };
  }
  return { ok: true, patch: raw as StatePatch };
}

/** Best-effort error text; never leaks a stack into the model context. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The scope a call addresses: an explicit override when the model passed
 * one (only ever a sub-agent scope name it learned from the system fragment
 * or from `skillstate_merge`), otherwise this session's own scope.
 */
function resolveScope(
  scope: string | undefined,
  context: ToolContext,
  deps: ToolDeps,
): string {
  return scope !== undefined && scope.length > 0 ? scope : deps.scopeFor(context.sessionID);
}

/* ------------------------------------------------------------------ */
/*  Registration                                                       */
/* ------------------------------------------------------------------ */

/**
 * Register the skillstate tools on an editor.
 *
 * The callback is synchronous, side-effect-free and replayable: OpenCode
 * re-runs it on every registry rebuild, so it must not do I/O at
 * registration time. All filesystem work happens inside `execute`.
 */
export function registerTools(editor: ToolEditor, deps: ToolDeps): void {
  editor.namespace({
    name: 'skillstate',
    description: 'Persist project notes across context resets and compaction.',
  });

  /* -- skillstate_read ---------------------------------------------- */

  editor.add({
    name: 'skillstate_read',
    description:
      'Read the notes this session has saved for the current project (file: .skillstate/skillstate.json). Use after a context reset or compaction to recover earlier decisions, file paths, and remaining work. Returns the stored document, or an empty object when nothing is saved yet.',
    input: object({
      scope: {
        type: 'string',
        description:
          'Optional sub-agent scope to read instead of this session. Omit to read this session own notes.',
      },
    }),
    output: READ_OUTPUT,
    async execute(input: unknown, context: ToolContext) {
      const scope = resolveScope(readReadInput(input).scope, context, deps);
      const state = deps.store.read(scope);
      return render<ReadValue>(
        ok({
          state,
          path: deps.store.pathFor(scope),
          scope,
          empty: Object.keys(state).length === 0,
        }),
      );
    },
  });

  /* -- skillstate_update -------------------------------------------- */

  editor.add({
    name: 'skillstate_update',
    description:
      'Merge a patch into the notes this session has saved for the project. Keys merge shallowly, nested objects merge recursively, and a null value deletes that key. Use it to record a decision already made, a file path already located, or what is still outstanding - not to log the conversation. Returns the merged document and which keys changed.',
    input: object(
      {
        patch: {
          type: 'object',
          description:
            'Sparse patch to merge, e.g. {"decisions":["..."],"todo":["..."]}. Set a key to null to delete it.',
        },
      },
      ['patch'],
    ),
    output: UPDATE_OUTPUT,
    async execute(input: unknown, context: ToolContext) {
      const checked = normalizePatch(readUpdateInput(input).patch);
      if (!checked.ok) return render<UpdateValue>(refuse(checked.reason));
      // §6.2, when there is a P to validate against. Deterministic, runtime-side,
      // and it never sees the model: a refused patch leaves Σ exactly as it was.
      if (deps.schema !== undefined) {
        const verdict = validatePatch(deps.schema, checked.patch as SkillState);
        if (!verdict.valid) {
          // The declared fields go in the refusal. §6.4's rollback is that a
          // rejected patch has no path into Σ, which means the model gets one
          // more turn with nothing changed — so the refusal has to say what the
          // alternative is, or the model retries the identical patch. Naming the
          // offending key alone is a dead end it cannot act on.
          return render<UpdateValue>(
            refuse(
              `${verdict.error} (field: ${verdict.field}). ` +
                `This project declares: ${Object.keys(deps.schema).join(', ') || 'no fields'}.`,
            ),
          );
        }
      }
      const scope = resolveScope(undefined, context, deps);
      try {
        const { state, changes } = await deps.store.patch(scope, checked.patch);
        deps.onWrite?.(scope);
        return render<UpdateValue>(
          ok({ state, changes, path: deps.store.pathFor(scope), scope }),
        );
      } catch (error) {
        return render<UpdateValue>(
          refuse(`Could not save the notes: ${errorMessage(error)}`),
        );
      }
    },
  });

  /* -- skillstate_merge --------------------------------------------- */

  editor.add({
    name: 'skillstate_merge',
    description:
      'Fold a sub-agent saved notes into this session notes. Call it with no arguments from a root session to fold in every sub-agent of this session, or pass a sub-agent scope to fold just that one. Nested objects merge; conflicting values keep the existing one unless you pass keep: "source".',
    input: object({
      scope: {
        type: 'string',
        description:
          'Sub-agent scope to fold in. Omit to fold in every sub-agent of this session.',
      },
      keep: {
        type: 'string',
        enum: ['existing', 'source'],
        description:
          'Which side wins a conflict. Defaults to "existing", this session value.',
      },
    }),
    output: MERGE_OUTPUT,
    async execute(input: unknown, context: ToolContext) {
      if (context.signal.aborted) return render<MergeValue>(refuse('Cancelled.'));
      if (deps.scopeFor(context.sessionID) !== '') {
        return render<MergeValue>(
          refuse(
            'skillstate_merge is only available to the root session. Write your findings with skillstate_update instead - the main session folds them in.',
          ),
        );
      }
      const { scope, keep } = readMergeInput(input);
      // A bulk fold enumerates SESSION ids from the registry, so each one has
      // to be translated to the scope name it writes under. An explicit
      // `scope` is already a scope name (the model read it from the system
      // fragment) and must be passed through untouched.
      const targets =
        scope !== undefined
          ? [{ scope, label: scope }]
          : deps.sessions
              .descendantsOf(context.sessionID)
              .map((sessionID) => ({ scope: deps.scopeFor(sessionID), label: sessionID }));
      if (targets.length === 0) {
        return render<MergeValue>(
          ok({ state: deps.store.read(''), changes: emptyChanges(), merged: [], skipped: [] }),
        );
      }
      const merged: string[] = [];
      const skipped: string[] = [];
      let state: Record<string, unknown> = {};
      let changes: StateChanges = emptyChanges();
      for (const target of targets) {
        try {
          const result = await deps.store.merge('', target.scope, keep);
          state = result.state;
          changes = result.changes;
          merged.push(target.label);
        } catch {
          skipped.push(target.label);
        }
      }
      return render<MergeValue>(ok({ state, changes, merged, skipped }));
    },
  });
}

/** A change set with nothing in it. */
function emptyChanges(): StateChanges {
  return { added: [], updated: [], deleted: [] };
}

export { stateScopeFor };
