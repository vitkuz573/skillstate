# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.0.0] - 2026-09-05

**Breaking:** the host integration is now **project-local**. The global
machine install (`npm i -g @skillstate/cli`) is the only global thing —
`skillstate init` writes NOTHING into `~` anymore. All glue lives inside the
project and is committed, so a fresh clone works for the whole team without
any teammate installing skillstate globally. Existing `~`-based installs must
be re-initialized (and rolled back with the old tooling removed by this
release — there is no migration path).

### Changed

- **Project-local glue for every detected host.** `skillstate init` (no
  `--host` flag) wires OpenCode, Claude Code, and Codex markers ALL AT ONCE:
  state + spec + skill + MCP + hooks land inside the project; switching
  harnesses needs no re-init. Host detection reads `~/.config/opencode`,
  `~/.claude`, and `~/.codex` markers only.
- **One shared project skill.** A single host-neutral
  `.claude/skills/skillstate/SKILL.md` serves both OpenCode and Claude Code
  (OpenCode reads project `.claude/skills/` too). No skill files are ever
  written to `~/.config/opencode`, `~/.claude`, or `~/.codex`.
- **OpenCode wiring is an npm plugin.** The project `opencode.json(c)` gets
  `"plugin": ["@skillstate/opencode"]` (auto-installed by OpenCode via Bun)
  plus an `mcp.skillstate` local server `{ npx, -y, @skillstate/mcp@^3 }` —
  no generated plugin file, nothing under `~/.config/opencode`, timestamped
  backup when the config changes.
- **Claude Code wiring is project-level.** Hook groups
  (`UserPromptSubmit` / `SessionStart(^compact$)` / `PostToolUse(^Bash$)`)
  merge into the project `.claude/settings.json` with
  `node "$CLAUDE_PROJECT_DIR/.claude/hooks/skillstate/<event>.cjs"` commands;
  self-contained `.cjs` scripts are written to `<project>/.claude/hooks/
  skillstate/`; the project `.mcp.json` gets the `skillstate` stdio server
  (`npx -y @skillstate/mcp@^3`).
- **New `skillstate install` command (machine-level, Codex only).** Writes
  `~/.codex/hooks/skillstate/*.cjs`, merges `~/.codex/hooks.json`, and appends
  the `[mcp_servers.skillstate]` TOML table (`npx -y @skillstate/mcp@^3`) to
  `~/.codex/config.toml`. Idempotent; machine manifest at
  `~/.skillstate/install-manifest.json`. For opencode/claude it prints that
  nothing machine-wide is needed — their glue belongs to `skillstate init`.
- **Multi-host manifest v2.** `.skillstate/install-manifest.json` is now
  `{ version: 2, installedAt, statePath, skillPath?, hosts: { opencode?,
  claude? } }` and re-init MERGES host records (adding a harness later =
  re-run `init`). v1 manifests are NOT migrated — they are reported as
  corrupt.
- **Inert until init.** The OpenCode plugin, the Claude/Codex hook scripts,
  and the MCP server are all no-ops when the project has no `.skillstate/`
  state — the plugin does not trim/inject, hooks inject nothing and never
  create state files, and MCP tools return `no skillstate state in this
  directory — run \`skillstate init\`` (only `spec.get` works). Fresh clones
  behave like vanilla hosts.
- **`init` no longer creates a root `skillstate.json` config file** — `run`
  and `report` use the built-in config defaults. The spec lands at
  `skill-spec.json` (`--spec <path>` or the domain-neutral generic spec).
- **MCP entries reference `npx -y @skillstate/mcp@^3`** everywhere; the
  `skillstate-mcp` bin is no longer referenced by any installer.
- All packages are released together at `3.0.0`.

### Added

- `skillstate install [--dry-run]` — machine-level Codex glue (see above).
- `--machine` flag on `skillstate uninstall` — rolls the Codex machine glue
  back exactly as the machine manifest records (hooks removed surgically so
  foreign hooks survive).

### Removed

- `--host`, `--max-history`, `--no-mcp`, `--no-skill`, `--example ctf`,
  `--auto`, and `init --uninstall` — `init` has exactly
  `[--spec <path>] [--dry-run]` left.
- `resolveMcpCommand*` helpers — MCP registration now writes the fixed
  `npx -y @skillstate/mcp@^3` entry directly.
- All `~`-based wiring from `init` (plugins/skills/hooks under
  `~/.config/opencode`, `~/.claude`, `~/.codex`) and the generated
  `skillstate.plugin.ts` / SKILL.md-per-host installs.

## [2.0.0] - 2026-09-03

**Breaking:** the project was split from the single monolithic `skillstate`
package into an npm **workspaces monorepo** of independently published scoped
packages under the `@skillstate/*` scope. The root package is now `private`
and ships no code. Every public import path moved — there is no compat
re-export under the old root, so all `skillstate/...` imports must be updated.

### Changed

- **Package split.** One package → seven scoped packages, one per workspace in
  `packages/*`: `@skillstate/core`, `@skillstate/claude`, `@skillstate/opencode`,
  `@skillstate/codex`, `@skillstate/mcp`, `@skillstate/cli`, `@skillstate/bench`.
  Imports change from `skillstate/...` to the matching `@skillstate/...` package.
- **Core API lives in `@skillstate/core`.** The runtime, state manager, prompt
  transformer (`formatPaper`), token tracker, types, and all `@non-paper` helpers
  (instrumentation, resilience, validate, redaction, atomic-write, state-store,
  migrations, events, logger, clock, provider, config, shutdown) moved here. The
  canonical CTF spec is available via the `@skillstate/core/schemas` subpath.
- **Adapters.** `ClaudeAdapter` → `@skillstate/claude`, `OpenCodeAdapter` +
  `SkillStatePlugin` → `@skillstate/opencode`, `CodexAdapter` →
  `@skillstate/codex`, `McpAdapter` + `McpServer` + `launch` →
  `@skillstate/mcp`. Each adapter package depends on `@skillstate/core` `^2.0.0`.
- **CLI & MCP.** `skillstate` bin (`init | run | report`) now ships from
  `@skillstate/cli`; the new `skillstate-mcp` bin ships from `@skillstate/mcp`.
- **Benchmark.** The deterministic harness is published as `@skillstate/bench`
  (entry-only) and run in the repo with `npm run bench`.
- **Versioning.** All scoped packages are released together at `2.0.0`
  (previous release: `1.1.2`).

## [1.0.0] - 2026-09-03

Initial release — the SKILL.state runtime from
[arXiv:2608.26263](https://arxiv.org/abs/2608.26263) as a TypeScript ESM library.

### Added

**Core runtime (`skillstate/core`)**

- `SkillStateRuntime` — the Algorithm 1 loop: paper-exact prompt `(P, Σₜ, Oₜ)` →
  LLM → schema validation of ΔΣₜ → ⊕ merge → action execution, with `step()`
  and `run()` drivers.
- §7 rollback-retry cycle — failed parse/validation re-prompts with corrective
  feedback (`maxValidationRetries`, default 2 → max 3 attempts); deterministic
  fallback (`__invalid_patch__` sentinel, state untouched) after exhaustion.
- Reasoning discard — LLM reasoning `Rₜ` is returned in `StepResult` but never
  stored in state, so it cannot poison subsequent prompts.
- Non-mutating ⊕ merge with null-deletion semantics (`StateManager.mergeState`)
  — `null` deletes keys, nested objects merge recursively, inputs are never
  mutated (rollback is free).
- Schema validation for state patches (`StateManager.validatePatch`) — unknown
  keys and wrong types rejected; `null` always valid for deletion.
- State utilities: `createInitialState`, `computeTokenSavings`,
  `serializeState`/`deserializeState` (plus `StateManager` static wrapper and
  `createStateManager()` factory).
- Appendix A.4 verbatim paper prompt format (`PromptTransformer.formatPaper`)
  plus Claude, opencode, and generic prompt formatters.
- Typed response parsing (`PromptTransformer.parseResponse`) with the §5.7
  error taxonomy: `no_block`, `malformed_json`, `missing_state_patch`,
  `missing_action` — including recovery from unterminated (truncated) fences.

**Metrics (`skillstate/core`)**

- `TokenTracker` — per-step token recording, average prompt size, total tokens,
  Task Accuracy per §4.3 (`getMetrics().accuracy`), O(T²) conversation
  baseline comparison with reduction factor and USD cost savings
  (`compareWithBaseline`), JSON report export (`exportReport`), and
  persistence (`save`/`load`).

**Platform adapters**

- `ClaudeAdapter` (`skillstate/claude`) — Claude Code integration:
  `generateAppendPrompt()` mode boilerplate, `generateHookScript()` for
  `PreToolUse`/`PostToolUse` hooks (schema-validated null-deletion merge in
  self-contained CommonJS), plus prompt formatting and patch/action extraction.
- `OpenCodeAdapter` (`skillstate/opencode`) — opencode integration:
  `generateSkillMd()` (SKILL.md with execution-context frontmatter),
  `generatePluginCode()` (`tool.execute.before` plugin injecting persisted
  state), plus prompt formatting and patch/action extraction.

**Schemas (`skillstate/schemas`)**

- `INTERCODE_CTF_SPEC` — canonical InterCode CTF procedural spec (paper §3.1)
  with the fixed 5-field state schema: `discovered_flags`, `tested_hypotheses`,
  `active_files`, `working_dir`, `cmd_summary`.

**Quality**

- 299 tests, 100% coverage (branches, functions, lines, statements) enforced
  via Vitest.
- O(1)/O(T) footprint property test — prompt size stays constant modulo
  observation growth.
- TypeScript strict mode, ESM, bundled `.d.ts` for every entry point.

[1.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v1.0.0
[2.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v2.0.0
[3.0.0]: https://github.com/vitkuz573/skillstate/releases/tag/v3.0.0
