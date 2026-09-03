# Security Policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.x     | ✅        |

Only the latest minor release line receives security fixes.

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately to the maintainers:

1. Email **`security@skillstate.dev`** *( **TO UPDATE**: replace with the real
   maintainer security inbox before you ship — this is a placeholder.* )
2. Include: a description of the issue, steps to reproduce or a proof of
   concept, affected versions, and the impact assessment.
3. If possible, include a failing test that demonstrates the vulnerability.

You will receive an acknowledgment within **72 hours**. Fixes for confirmed
vulnerabilities are released as a patch version, and you will be credited in
the release notes (unless you prefer to remain anonymous).

Alternatively, use GitHub's private vulnerability reporting:

<https://github.com/vitkuz573/skillstate/security/advisories/new>

## Security policy

skillstate is designed around a strict confidentiality model. The guarantees
below are invariants, not aspirational:

- **No secrets in logs.** The runtime never writes token values, API keys,
  credentials, or raw secret material to stdout/stderr/log files. Diagnostic
  output is limited to schema-constrained execution state.
- **Redaction is built-in.** Every state read — including the MCP
  `state.get` / `state.metrics` tools — passes through the redaction layer
  before it leaves the runtime. Redaction cannot be bypassed by a read path.
- **Secrets are never persisted.** State files (`state*.json`) contain only
  schema-validated execution state, never credentials. There is no code path
  that writes a secret to disk.

## Scope notes

skillstate is an in-process library — it ships no network endpoints and no
persistent daemons. Areas worth scrutiny:

- **Hook/plugin code generation** (`ClaudeAdapter.generateHookScript`,
  `OpenCodeAdapter.generatePluginCode`) — generated scripts read and write
  the state file path you pass them. Treat `statePath` values as
  configuration, not user input, and pass absolute paths in production.
- **State persistence** (`TokenTracker.save`/`load`) — state files are
  JSON parsed on load; do not point the tracker at untrusted files.
- **LLM output handling** — patches are schema-validated before merging, and
  unknown keys are rejected, but the library never sanitizes *observation
  content*; prompts embedding untrusted observations are your trust boundary.
