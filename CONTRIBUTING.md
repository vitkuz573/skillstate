# Contributing to skillstate

Thanks for your interest in contributing! This project maintains an
enterprise-grade quality bar: **100% test coverage** is enforced, and every
behavior change lands test-first.

## Developing

Requirements: **Node.js >= 20** and npm with workspaces support (this is a
monorepo: `packages/*` under a `private: true` root). `.npmrc` sets
`engine-strict=true`, so a Node version below 20 will be rejected at install
time.

```bash
git clone https://github.com/vitkuz573/skillstate.git
cd skillstate
npm ci                  # reproducible install from package-lock.json
```

Verify your setup — the full local gate:

```bash
npm run typecheck       # tsc -b across the workspace, must be clean
npm test                # the full suite
npm run test:coverage   # 100% thresholds enforced on all four metric kinds
npm run build           # emits dist/
```

A deep dive into the design and execution-state model lives in
[`state.md`](./state.md); usage and public API examples are in
[`README.md`](./README.md). Keep both consistent with any public signature
change you land.

## Test-driven development is required

Every behavior change follows the RED → GREEN → REFACTOR cycle:

1. **RED** — write a failing test that captures the desired behavior *first*.
   Run `npm test` and confirm the new test fails for the right reason.
2. **GREEN** — write the minimal implementation that makes the test pass.
3. **REFACTOR** — clean up while keeping the suite green.

A PR whose implementation arrives without its tests is not reviewable. If you
are fixing a bug, the regression test must reproduce the bug before the fix
lands.

## Testing

The project enforces a hard quality bar via Vitest v8 coverage (`v8`)
declared in `vitest.config.ts`. `npm run test:coverage` fails the build unless
**100%** is met on **all four metric kinds**:

- **branches** — every branch of every `if`/`switch`/logical expression;
- **functions** — every exported and internal function is executed;
- **lines** — every executable line is hit;
- **statements** — every statement is evaluated.

Run the suite locally before pushing:

```bash
npm test                # all tests; the count is deliberately not recorded here
npm run test:coverage   # 100% on branches/functions/lines/statements
```

## The 100% coverage rule

`npm run test:coverage` enforces **100% on branches, functions, lines, and
statements** (see `vitest.config.ts`). PRs below the threshold are rejected.

- No `// istanbul ignore` / `/* v8 ignore */` suppression comments without a
  written justification in the PR description.
- Untestable platform glue should be isolated and covered through its public
  contract, not suppressed.
- If a branch is genuinely unreachable, remove it rather than ignore it.

## Conventional commits

Commit messages follow the [Conventional Commits](https://www.conventionalcommits.org/)
specification:

```
<type>(<scope>): <short summary>

[optional body]
```

Common types:

| Type | Use for |
| --- | --- |
| `feat` | New behavior or public API |
| `fix` | Bug fix |
| `test` | Test-only changes |
| `refactor` | Code change with no behavior change |
| `perf` | Performance improvement |
| `docs` | Documentation only |
| `chore` | Tooling, config, dependencies |

Example: `feat(core): add maxValidationRetries option to SkillStateRuntime`

## Pull request process

1. Fork the repo and create a branch from `main`:
   `git checkout -b feat/my-feature`
2. Make your changes test-first (see above).
3. Run the full gate locally before pushing:
   ```bash
   npm run typecheck && npm test && npm run test:coverage && npm run build
   ```
4. Push and open a PR against `main`. The PR must:
   - pass the full local gate (typecheck, tests, 100% coverage, build);
   - include tests for every new behavior;
   - keep every code example in `README.md` consistent with real exports —
     if you change a public signature, update the README in the same PR;
   - add a `CHANGELOG.md` entry under *Unreleased* for user-visible changes.
5. Keep PRs focused: one behavior or fix per PR.

## Releasing

Releases are cut from `main` by a maintainer after the full local gate passes
(typecheck → tests → 100% coverage → build). There is no CI pipeline, so the
gate is run by hand before every publish.

```bash
# 1. Run the full gate
npm run typecheck && npm test && npm run test:coverage && npm run build

# 2. Add/verify the CHANGELOG.md entry under *Unreleased*, then tag:
npm version patch|minor|patch -m "chore(release): %s"
```

### Publishing

This is an npm **workspaces monorepo**. The root `package.json` is
`private: true`, so a bare `npm publish` fails — each package is published
separately with `-w`:

```bash
for p in core claude codex mcp opencode cli bench; do
  npm publish -w @skillstate/$p --access public
done
```

**Order is not arbitrary.** `@skillstate/core` is a dependency of every other
package, and `cli` depends on the host adapters. Publishing a dependent before
its dependency makes the install fail on an unresolvable version, because npm
resolves from the registry the moment a version is out. The order above is
topological:

```
core -> claude, codex, mcp, opencode -> cli -> bench
```

npm takes a few minutes to propagate a new version, so `npm view
@skillstate/core version` can still report the previous one immediately after
`npm publish` reports success. Verify with a clean install before announcing.

Publishing is **irreversible** — a published version can never be replaced,
only superseded. A mistaken release means cutting a patch version, so check
the tarball first:

```bash
npm pack -w @skillstate/<pkg> --dry-run   # file list, sizes
```

`npm version` runs the `prepack` script (`npm run build`) synchronously, so
`dist/` is always freshly built into the published tarball. Never publish from
a dirty working tree or a branch other than `main`.

### Registry authentication

The account has 2FA enabled, so a publish needs a token that bypasses it —
a plain token fails with:

```
403 Forbidden - Two-factor authentication or granular access token
with bypass 2fa enabled is required to publish packages.
```

Create one at <https://www.npmjs.com/settings/vitkuz573/access-tokens>:

- **Automation** — simplest, bypasses 2FA automatically; or
- **Granular** — scope it to `@skillstate`, set *Read and write*, and tick
  **Bypass 2FA**.

Store it in `~/.npmrc` (mode 0600), never in the repository — the tracked
`.npmrc` holds only `engine-strict` and the registry URL, and must stay that
way.

## Paper fidelity

skillstate implements the SKILL.state runtime from
[arXiv:2608.26263](https://arxiv.org/abs/2608.26263). Changes that alter
paper-defined behavior (Algorithm 1 loop, ⊕ null-deletion merge, the A.4
prompt format, §7 rollback-retry, §4.3 metrics) must state their paper
rationale in the PR description.

## Reporting bugs

Open a [GitHub issue](https://github.com/vitkuz573/skillstate/issues) with:
the minimal reproduction, expected vs actual behavior, Node version, and —
if relevant — the failing test. Security issues follow
[SECURITY.md](./SECURITY.md), not public issues.

## License

By contributing, you agree that your contributions will be licensed under
the [MIT License](./LICENSE).
