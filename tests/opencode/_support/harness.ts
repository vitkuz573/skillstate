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

  /**
   * Remove a tool.
   *
   * Real, not a throw. The plugin withdraws its own tools when a project leaves
   * paper mode, and paper mode registers none — so a fake that forbade removal
   * would have hidden the code path that makes a mode change take effect, and
   * the one way to find out it is broken is to run it.
   *
   * Only ids this editor holds are affected; anything else is a no-op, which is
   * what the host does and what keeps the plugin from deleting a tool it never
   * registered.
   */
  remove(id: string): void {
    if (!this.tools.has(id)) return;
    this.tools.delete(id);
    const at = this.order.indexOf(id);
    if (at >= 0) this.order.splice(at, 1);
  }

  /**
   * Put a tool in the registry without going through `add`.
   *
   * For tools this package did not register: they arrive from the host and from
   * other plugins, and the editor has to be able to hold them so that `list`
   * and `remove` can be exercised against a mix.
   */
  pushExisting(id: string): void {
    if (!this.order.includes(id)) this.order.push(id);
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
  /** The raw payloads the runtime sent, so a host schema can be checked. */
  payloads?: Array<{ sessionID: string; text?: unknown }>;
  /** Make `session.prompt` throw, as a host does for an ended session. */
  promptRefuses?: boolean;
  /** Throw a bare string, so the non-`Error` branch of the diagnostic is real. */
  promptThrowsString?: boolean;
}

/** The fake context plus the recordings the tests assert on. */
export interface PluginHarness {
  /** Pass to `SkillStatePlugin.setup`. */
  readonly ctx: unknown;
  /** Replay every `tool.transform` callback and return what it registered. */
  capturedTools(): CapturedTools;
  /** Registered session hooks, keyed by hook name. */
  readonly hooks: Map<string, CapturedHook>;
  /** Push more events onto the running stream. */
  emit(events: unknown[]): void;
  /** Ids the plugin asked the host to remove, in order. */
  removedTools(): readonly string[];
  /** Register a tool the plugin does not own. */
  addForeignTool(id: string): void;
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
/**
 * A `session.created` event in the shape the host publishes it.
 *
 * The `info` object is the part that matters and the part that is easy to omit:
 * `info.directory` is the only place on the whole event stream that says which
 * project a session belongs to, and the plugin skips any session it cannot place.
 * A fixture without it produces a session the plugin must ignore, which is
 * correct behaviour and makes every test that drives it fail for the wrong
 * reason.
 */
/**
 * Give a session event the project it belongs to, if it did not name one.
 *
 * The harness models ONE project — the one `projectDir` names — so a fixture
 * that says `session.created` without `info.directory` is an incomplete event
 * rather than a session from somewhere else. Filling it in keeps a dozen tests
 * from having to repeat the harness's own directory at every call site, and
 * keeps the one thing that actually matters testable: a session that names a
 * DIFFERENT directory is still foreign, and `placeSession` does not touch it.
 */
function placeSession(event: unknown, projectDir: string): unknown {
  if (typeof event !== 'object' || event === null) return event;
  const typed = event as { type?: unknown; data?: Record<string, unknown> };
  if (typed.type !== 'session.created' && typed.type !== 'session.updated') return event;
  const data = typed.data;
  if (typeof data !== 'object' || data === null) return event;
  const info = data['info'];
  if (typeof info === 'object' && info !== null) return event;
  return { ...typed, data: { ...data, info: { directory: projectDir } } };
}

export function sessionCreated(
  sessionID: string,
  parentID?: string,
  directory?: string,
): Record<string, unknown> {
  return {
    type: 'session.created',
    data: {
      sessionID,
      ...(parentID === undefined ? {} : { parentID }),
      ...(directory === undefined
        ? {}
        : { info: { id: sessionID, projectID: 'prj_1', directory, path: directory } }),
    },
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
  // Tools the host or another plugin put there, so a test can prove the plugin
  // does not sweep them up when it withdraws its own.
  const foreignTools = new Map<string, CapturedTool>();
  const removed: string[] = [];
  /** Wakes a subscription that has parked with an empty queue. */
  const wakers = new Set<() => void>();
  const prompts: string[] = options.prompts ?? [];
  const payloads: Array<{ sessionID: string; text?: unknown }> = options.payloads ?? [];
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
      prompt: async (input: { sessionID: string; text?: unknown }) => {
        prompts.push(input.sessionID);
        payloads.push(input);
        if (options.promptRefuses === true) throw new Error('session is busy');
        if (options.promptThrowsString === true) throw 'a bare string, not an Error';
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
                yield placeSession(next, options.projectDir);
                continue;
              }
              const signal = subscribeOptions?.signal;
              if (signal === undefined || signal.aborted) return;
              // Park until ABORTED **or** until more events arrive. Parking only
              // on abort is what a long-lived stream really does, and it is
              // exactly why a test cannot express "the loop is still running, and
              // the world changed underneath it": a queue that runs dry ends the
              // loop, and every later `emit` lands on a generator nobody reads.
              await new Promise<void>((resolve) => {
                const wake = (): void => {
                  cleanup();
                  resolve();
                };
                const cleanup = (): void => {
                  signal.removeEventListener('abort', wake);
                  wakers.delete(wake);
                };
                wakers.add(wake);
                signal.addEventListener('abort', wake, { once: true });
              });
              if (signal.aborted) return;
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
    /**
     * Push more events onto the live stream.
     *
     * A mode change is a change to a FILE, not to the event stream, so a test
     * has to be able to keep feeding the subscription after it has started
     * running. Without this the only way to express "the loop is still going,
     * and now the config changed" is a second harness, which is a second
     * process and a second plugin instance — and the whole claim is about what
     * ONE instance does when the world changes under it.
     */
    emit(events: unknown[]): void {
      queue.unshift(...events);
      for (const wake of [...wakers]) wake();
    },
    /** Ids the plugin asked the host to remove, in order. */
    removedTools(): readonly string[] {
      return removed;
    },
    /**
     * Register a tool the plugin does not own, so a sweep can be caught.
     *
     * Present because `editor.remove` takes an id rather than a predicate: the
     * plugin has to be able to tell "mine" from "theirs", and the only way to
     * prove it does is to put a tool in it does not own and watch it survive.
     */
    addForeignTool(id: string): void {
      foreignTools.set(id, { id, name: id } as unknown as CapturedTool);
    },
    capturedTools(): CapturedTools {
      const editor = new FakeToolEditor();
      for (const [id, tool] of foreignTools) {
        editor.tools.set(id, tool);
        editor.pushExisting(id);
      }
      for (const callback of transformCallbacks) {
        callback(
          new Proxy(editor, {
            get(target, prop, receiver) {
              if (prop === 'remove') {
                return (id: string) => {
                  removed.push(id);
                  target.remove(id);
                };
              }
              const value = Reflect.get(target, prop, target) as unknown;
              return typeof value === 'function' ? (value as () => void).bind(target) : value;
            },
          }) as ToolEditor,
        );
      }
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
