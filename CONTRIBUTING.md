# Contributing to skillstate

Thanks for your interest in contributing! This project maintains an
enterprise-grade quality bar: **100% test coverage** is enforced, and every
behavior change lands test-first.

## Local development setup

Requirements: **Node.js >= 20** and npm.

```bash
git clone https://github.com/vitkuz573/skillstate.git
cd skillstate
npm install
```

Verify your setup:

```bash
npm test                # 299 tests should pass
npm run test:coverage   # 100% thresholds enforced
npm run typecheck       # tsc --noEmit, must be clean
npm run build           # emits dist/
```

## Test-driven development is required

Every behavior change follows the RED → GREEN → REFACTOR cycle:

1. **RED** — write a failing test that captures the desired behavior *first*.
   Run `npm test` and confirm the new test fails for the right reason.
2. **GREEN** — write the minimal implementation that makes the test pass.
3. **REFACTOR** — clean up while keeping the suite green.

A PR whose implementation arrives without its tests is not reviewable. If you
are fixing a bug, the regression test must reproduce the bug before the fix
lands.

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
