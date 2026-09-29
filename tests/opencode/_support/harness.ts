/**
 * Test harness for the OpenCode v2 plugin.
 *
 * The plugin only touches four pieces of the OpenCode context —
 * `location`, `tool.transform`, `session.hook` and `event.subscribe` — so
 * the fake below implements exactly those and records what was registered.
 * Anything the plugin starts using that is not here shows up immediately as
 * a missing member, which is the point: the harness fails loudly rather than
 * silently diverging from the real API.
 */

import { SkillStatePlugin } from '@skillstate/opencode';
import type { ToolContext, ToolEditor } from '@opencode/plugin/promise/tool';

/** A registered tool, as the editor sees it. */
export interface CapturedTool {
  readonly name: string;
  readonly description: string;
  readonly input: unknown;
  readonly execute: (input: unknown, context: ToolContext) => Promise<unknown>;
}

/** A registered session hook. */
export type CapturedHook = (event: unknown) => Promise<void> | void;

/** Result of replaying every `ctx.tool.transform` callback. */
export interface CapturedTools {
  readonly namespaces: Array<{ name: string; description: string }>;
  readonly tools: Map<string, CapturedTool>;
  /** Look a tool up by name, failing loudly when it is absent. */
  require(name: string): CapturedTool;
}

/** A minimal `ToolEditor` that records additions. */
export class FakeToolEditor implements ToolEditor {
  readonly namespaces: Array<{ name: string; description: string }> = [];
  readonly tools = new Map<string, CapturedTool>();
  private readonly order: string[] = [];

  namespace(namespace: { name: string; description: string }): void {
    this.namespaces.push({ ...namespace });
  }

  add(tool: {
    name: string;
    description: string;
    input: unknown;
    execute: (input: unknown, context: ToolContext) => Promise<unknown>;
  }): void {
    this.tools.set(tool.name, tool as CapturedTool);
    this.order.push(tool.name);
  }

  update(): void {
    throw new Error('skillstate must not update tools owned by other plugins');
  }

  remove(): void {
    throw new Error('skillstate must not remove tools owned by other plugins');
  }

  list(): readonly (CapturedTool & { readonly id: string })[] {
    return this.order.map((name) => ({
      ...(this.tools.get(name) as CapturedTool),
      id: name,
    }));
  }

  get(id: string): (CapturedTool & { readonly id: string }) | undefined {
    const tool = this.tools.get(id);
    return tool === undefined ? undefined : { ...tool, id };
  }
}

/** Options for {@link createPluginHarness}. */
export interface HarnessOptions {
  /** Canonical project directory the plugin should address. */
  projectDir: string;
  /** Events the fake stream yields before parking. */
  events?: unknown[];
  /** Make the event stream throw immediately. */
  failStream?: boolean;
  /** Session ids the runtime asked for a step on, in order. */
  prompts?: string[];
  /** Make `session.prompt` throw, as a host does for an ended session. */
  promptRefuses?: boolean;
}

/** The fake context plus the recordings the tests assert on. */
export interface PluginHarness {
  /** Pass to `SkillStatePlugin.setup`. */
  readonly ctx: unknown;
  /** Replay every `tool.transform` callback and return what it registered. */
  capturedTools(): CapturedTools;
  /** Registered session hooks, keyed by hook name. */
  readonly hooks: Map<string, CapturedHook>;
  /** Run `setup` and return its cleanup function. */
  start(): Promise<() => void>;
  /** Whether the plugin's subscription loop has exited. */
  streamEnded(): boolean;
}

/** Build a `ToolContext` for a tool `execute` call. */
export function fakeToolContext(
  overrides: { sessionID?: string; aborted?: boolean } = {},
): ToolContext {
  const controller = new AbortController();
  if (overrides.aborted === true) controller.abort();
  return {
    sessionID: overrides.sessionID ?? 'ses_root0000',
    agent: 'build',
    messageID: 'msg_0001',
    id: 'call_0001',
    signal: controller.signal,
    progress: async () => {},
  } as unknown as ToolContext;
}

/** A `session.created` event as the v2 server emits it. */
export function sessionCreated(
  sessionID: string,
  parentID?: string,
): Record<string, unknown> {
  return {
    type: 'session.created',
    data: { sessionID, ...(parentID === undefined ? {} : { parentID }) },
  };
}

/**
 * Create a harness bound to one fake plugin context.
 *
 * The event stream yields the supplied events, then parks on the abort
 * signal so the loop behaves like a live subscription without spinning —
 * an always-running generator would keep the test process alive forever.
 */
export function createPluginHarness(options: HarnessOptions): PluginHarness {
  const hooks = new Map<string, CapturedHook>();
  const transformCallbacks: Array<(editor: ToolEditor) => void> = [];
  const queue: unknown[] = [...(options.events ?? [])];
  const prompts: string[] = options.prompts ?? [];
  let ended = false;

  const ctx = {
    location: {
      directory: options.projectDir,
      project: { id: 'prj_1', directory: options.projectDir, canonical: options.projectDir },
    },
    tool: {
      transform: async (callback: (editor: ToolEditor) => void) => {
        transformCallbacks.push(callback);
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: CapturedHook) => {
        hooks.set(name, callback);
        return { dispose: async () => void hooks.delete(name) };
      },
      // The runtime's half of Algorithm 1. Stubbed rather than absent so a
      // test can assert that a step was requested, and so the "host refuses"
      // path — a session that has already ended — is reachable at all.
      prompt: async (input: { sessionID: string }) => {
        prompts.push(input.sessionID);
        if (options.promptRefuses === true) throw new Error('session is busy');
        return { id: 'msg_stub' } as never;
      },
    },
    event: {
      subscribe: (subscribeOptions?: { signal?: AbortSignal }) => ({
        async *[Symbol.asyncIterator]() {
          try {
            if (options.failStream === true) throw new Error('stream closed');
            for (;;) {
              const next = queue.shift();
              if (next !== undefined) {
                yield next;
                continue;
              }
              const signal = subscribeOptions?.signal;
              if (signal === undefined || signal.aborted) return;
              await new Promise<void>((resolve) => {
                signal.addEventListener('abort', () => resolve(), { once: true });
              });
              return;
            }
          } finally {
            ended = true;
          }
        },
      }),
    },
  };

  return {
    ctx,
    hooks,
    capturedTools(): CapturedTools {
      const editor = new FakeToolEditor();
      for (const callback of transformCallbacks) callback(editor);
      const { tools } = editor;
      return {
        namespaces: editor.namespaces,
        tools,
        require(name: string): CapturedTool {
          const tool = tools.get(name);
          if (tool === undefined) {
            throw new Error(
              `tool "${name}" was not registered; registered: ${[...tools.keys()].join(', ')}`,
            );
          }
          return tool;
        },
      };
    },
    async start(): Promise<() => void> {
      const cleanup = await (
        SkillStatePlugin.setup as (c: unknown) => Promise<() => void> | void
      )(ctx);
      return () => {
        if (typeof cleanup === 'function') cleanup();
      };
    },
    streamEnded(): boolean {
      return ended;
    },
  };
}
