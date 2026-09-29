<div align="center">

# @skillstate/opencode

**OpenCode v2 plugin for the @skillstate/core runtime — three native tools and one additive system fragment.**

[![npm version](https://img.shields.io/npm/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![node](https://img.shields.io/node/v/@skillstate/opencode)](https://www.npmjs.com/package/@skillstate/opencode)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](https://github.com/vitkuz573/skillstate/blob/main/LICENSE)

</div>

---

`@skillstate/opencode` integrates the paper-exact runtime
([`@skillstate/core`](../core)) into **OpenCode v2**. The integration is the
npm package itself, loaded from the PROJECT `opencode.json(c)` under the v2
`plugins` key. It registers three native tools and one `context` hook, and it
is project-local and inert when the project has no `.skillstate/` state.

> **@non-paper** — no adapters exist in arXiv 2608.26263v3. This adapter is an
> additive integration, not part of the paper.

## Installation

```bash
npm i @skillstate/core @skillstate/opencode
```

Requires Node.js >= 20 and OpenCode >= 2.0. TypeScript types are bundled, and
`@opencode/plugin` is a real dependency — the plugin is typed against the
host's own API rather than against hand-written local declarations.

## Configure OpenCode

`skillstate init` writes this for you. By hand:

```jsonc
// opencode.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["@skillstate/opencode"]
}
```

That is the whole configuration. The MCP server is deliberately NOT
registered here — see below.

OpenCode v1 is not supported: the config key was `plugin`, and a v1 plugin
implementation does not run in v2 at all. `skillstate init` migrates a config
written by an earlier version — our entry is removed from the legacy `plugin`
array, the key is dropped when nothing of yours is left in it, and an
`mcp.skillstate` entry from a previous install is removed.

### Why there is no MCP entry here

The MCP server is still shipped and still registered for **Claude Code,
Codex and any other MCP-capable host** — there it is the only way in. In
OpenCode the plugin already provides native tools, so registering both is not
free redundancy:

    native   3 tools    3 357 chars   ~839 tokens
    MCP     14 tools    9 814 chars  ~2 454 tokens
    extra                 6 457 chars  ~1 614 tokens on EVERY request

`spec.get` pours a further 1 286 characters of prose into context per call.

Worse, the two surfaces disagree about what may be written, over one file:

    native write -> {"added":["decision"],"updated":[],"deleted":[]}
    MCP    write -> {"valid":false,"error":"Unknown key: decision"}

The native tools are schema-free; the MCP server validates against the
procedural spec. With both advertised, whether a note is saved depends on
which one the model happened to pick.

## What the plugin registers

```ts
import SkillStatePlugin from '@skillstate/opencode';

await SkillStatePlugin.setup(ctx);
```

| Registration | Detail |
| --- | --- |
| `ctx.tool.transform(...)` | `skillstate_read`, `skillstate_update`, `skillstate_merge` |
| `ctx.session.hook('context')` | pushes ONE bounded fragment onto `event.system` |
| `ctx.event.subscribe(...)` | session parent edges, for sub-agent scoping |

Nothing else. It does not register `compaction`, `generate` or `title` hooks,
and it never touches `event.messages`.

### Tools

Every tool returns a discriminated result, because a tool that declares an
`output` schema must return a value matching it — a failure path that returned
only text is rejected by the host with "tool did not return its declared
output", which loses the reason.

```ts
{ ok: true,  value: {...} }
{ ok: false, error: "..." }   // e.g. a patch over the 64 KiB budget
```

| Tool | Purpose |
| --- | --- |
| `skillstate_read` | what this session has already saved |
| `skillstate_update` | merge a patch — the only write path (`null` deletes a key) |
| `skillstate_merge` | fold sub-agent notes back into the root session |

Scoping is automatic: the session's own scope comes from
`ToolContext.sessionID` plus the session registry, so the model never passes a
session id and can never write another agent's file by guessing one.

## Why the transcript is never rewritten

The previous version of this plugin rewrote the conversation on every model
request:

```ts
// removed — this is what broke it
const trimmed = messages.filter((m) => m.info.role !== 'system').slice(-maxHistory);
messages.length = 0;
messages.push(...systemMessages, ...trimmed, stateMessage);
```

Two independent failures in three lines:

1. `slice(-3)` **deleted the task statement, the tool results and the error
   messages** the agent had just been given. It was reasoning about work it
   could no longer see. Users reported that the agent "started talking
   nonsense and would not do my tasks" — it could not, because the task was
   no longer in the prompt.
2. The injected message was appended **last**, as `role: "user"`. For a chat
   model the last user message is the current instruction, so a JSON blob of
   state displaced the user's actual request.

The old test suite asserted the bug — `expect(messages).toHaveLength(1 + 3 + 1)`.
It is replaced by `tests/opencode/context-integrity.test.ts`, which asserts the
opposite.

Three rules, each enforced by a test:

| Rule | Enforced by |
| --- | --- |
| Never mutate `event.messages` | `context-integrity.test.ts` |
| Never inject behavioural instructions | `system-hint.test.ts` |
| Inert until a state file exists | `plugin.test.ts` |

Measured on a live OpenCode 2.0.19, one session, five turns:

```
turn 1: messages= 3  hint=True  marker=True  override=False
turn 3: messages= 7  hint=True  marker=True  override=False
turn 5: messages=11  hint=True  marker=True  override=False
```

The transcript grows. Under the previous version it was pinned at 3.

### The system fragment

Advisory, bounded, and deliberately dull. It names the state file, renders the
current notes (a large document is summarized to a key list plus a pointer to
`skillstate_read`), lists the tools, and says the notes are a side channel
rather than the task. It contains no "you must", no "always", and no output
format — that framing is what turned a persistence aid into a prompt override.

The wording is a product requirement, not prose taste, and
`system-hint.test.ts` fails the build if that framing creeps back.

## Design notes

- **Per-project addressing.** State resolves from
  `ctx.location.project.canonical`, never `process.cwd()` — one v2 server
  serves many projects, so the process cwd is the wrong answer.
- **Sub-agent isolation.** The parent edge comes from the real event stream
  (`session.created` / `session.forked`, `data.parentID`). A session is
  scoped to `<parentPrefix>-<full session id>`; the full id, not a prefix, so
  two siblings sharing an 8-char prefix cannot collapse into one file.
- **No premature trust.** A session not yet seen on the stream is treated as a
  root session, which is what a single-session user expects.
- **Durability.** Every mutation runs under the core cross-process lock and
  lands via temp-sibling → fsync → rename. Reads never throw.
- **Bounded prompt cost.** State above 4 KB is summarized rather than inlined,
  and a patch above 64 KiB is refused with a reason.

## The paper adapter

`OpenCodeAdapter` is still exported. It is the paper-exact `PlatformAdapter`
(A.4 prompt format) used by the benchmark — it is **not** the host
integration, and nothing in the plugin path calls it. Note that its
`injectState` still emits the paper's `STATE_PATCH_CONTRACT`, which is
exactly the instruction pattern the plugin avoids.

## Tests

```bash
npm test -- --project opencode
```

| File | Covers |
| --- | --- |
| `context-integrity.test.ts` | the transcript is never rewritten |
| `system-hint.test.ts` | the fragment never overrides the model |
| `session-registry.test.ts` | the v2 event shape, the session tree, eviction |
| `state-store.test.ts` | addressing, atomicity, merge semantics |
| `tools.test.ts` | schemas, validation, scoping, refusals |
| `plugin.test.ts` | setup, teardown, per-project addressing |

Coverage thresholds are 100% on statements, branches, functions and lines.

## License

MIT
