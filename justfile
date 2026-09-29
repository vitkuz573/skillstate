# skillstate — task runner.
#
# The quality gate is a LOCAL command, not a CI service. That is a deliberate
# choice, not a gap: the previous badge with a test count rotted precisely
# because nothing ran the gate on every change. `just gate` is the single
# command that must pass before anything is committed, and it is the same
# command a reviewer asks for.
#
# Everything is zero-dependency beyond the Node toolchain. No task wrapper
# writes into package.json beyond scripts that already exist.

set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := false

# ─── The gate ─────────────────────────────────────────────────────────────
# Ordered by how fast a failure surfaces. `check` catches most typos in
# seconds; `coverage` is last because it is the slowest and its output is the
# one that decides.

# Fast loop: types and the full suite. What you run on every save.
check:
    @just _banner "check"
    npm run typecheck
    npm test

# Everything that must pass before a commit. Run this, or run the hook.
gate: check coverage build
    @just _banner "gate passed"

# 100% on all four metrics per package, enforced by vitest's own thresholds.
coverage:
    @just _banner "coverage"
    npm run test:coverage

# Type-check and emit every package's dist/.
build:
    @just _banner "build"
    npm run build

# Type-check without emitting.
typecheck:
    @just _banner "typecheck"
    npm run typecheck

# ─── Tests ────────────────────────────────────────────────────────────────

# The full suite.
test:
    @just _banner "test"
    npm test

# One package, e.g. `just test-pkg opencode`.
test-pkg package:
    @just _banner "test: {{package}}"
    npx vitest run --project {{package}}

# One file, e.g. `just test-file tests/opencode/feedback.test.ts`.
test-file file:
    @just _banner "test: {{file}}"
    npx vitest run {{file}}

# Watch one file. The loop you actually live in.
watch file:
    npx vitest {{file}}

# Watch a whole package.
watch-pkg package:
    npx vitest --project {{package}}

# ─── Measurement ──────────────────────────────────────────────────────────

# The deterministic local benchmark. Synthetic data, no model, no network.
bench:
    @just _banner "bench"
    npm run bench

# The A/B harness, which refuses to report a number it cannot defend.
# Pass run files: `just ab path/to/runs.json`.
ab *files:
    @just _banner "a/b"
    npm run build
    node ./packages/bench/dist/ab-cli.js {{files}}

# The historical corpus survey: what transcripts cost, priced honestly.
# 1810 real runs, no model required.
survey:
    @just _banner "survey"
    npm run build
    npx vitest run tests/bench/survey.test.ts

# ─── Housekeeping ────────────────────────────────────────────────────────

# Install the pre-commit hook, so the gate cannot be skipped by forgetting.
install-hooks:
    @mkdir -p .git/hooks
    @cp scripts/pre-commit .git/hooks/pre-commit 2>/dev/null || true
    @chmod +x .git/hooks/pre-commit 2>/dev/null || true
    @just _banner "pre-commit hook installed"

# Remove build output and coverage.
clean:
    @just _banner "clean"
    rm -rf coverage
    rm -rf packages/*/dist
    find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete
    @echo "cleaned"

# What is here.
help:
    @just --list --unsorted

# Show the tree, with sizes, for a fast orientation.
tree:
    @just _banner "tree"
    @ls -1 packages/
    @echo
    @for p in packages/*/; do printf '%-22s %s src files\n' "$p" "$$(ls $$p/src 2>/dev/null | wc -l)"; done

# ─── Internal ─────────────────────────────────────────────────────────────

_banner task:
    @printf '\n\033[1m▸ %s\033[0m\n' {{task}}
