/**
 * Resolving P — the procedural specification the paper's prompt is built on.
 *
 * ── This module is a re-export, and that is the whole point ────────────────
 *
 * The implementation moved to `@skillstate/core` (`spec-resolve.ts`). It used
 * to live here, and the MCP server carried a second, unrelated resolver of its
 * own. Two resolvers, two contracts, and they disagreed in three ways that only
 * running both could show: this one probed `<project>/skill-spec.json` and the
 * other did not; this one validated a spec before trusting it and the other
 * `JSON.parse`d one into place; and this one held a project's writes to the
 * schema only when the project had SHIPPED a spec, while the other enforced the
 * builtin fallback — so on a free-form notes project the MCP answered
 * `Unknown key: todo` for nine of the ten keys the state file actually had.
 *
 * Both write the same `.skillstate/skillstate.json`. Whichever rule is
 * stricter is the rule the agent feels, so a second resolver is not a
 * refactoring opportunity, it is a way for the enforcement to disagree with
 * itself.
 *
 * ── Why the plugin needs a spec at all ────────────────────────────────────
 *
 * A.4 is `Format(P, Σₜ, Oₜ)`, and P is the first argument. Paper mode
 * therefore cannot assemble a paper-conformant prompt without one, even
 * though the store ({@link ProjectStateStore}) is deliberately schema-free:
 * notes mode never shows the model a schema, so it never needs P.
 *
 * ── A malformed spec file must not reach the model ────────────────────────
 *
 * A half-written or hand-mangled `skill-spec.json` is exactly the kind of
 * input that produced the v1 failure, where the spec's own instructions
 * ("You are an autonomous CTF agent … find the flag") overrode the user. The
 * file is VALIDATED before it is trusted, field by field, and anything that
 * does not typecheck falls back to the built-in spec with the reason recorded.
 * There is no code path that feeds an unvalidated P to the model.
 *
 * This module is not `strict`: a broken spec costs the model its
 * customisation, and failing a live agent loop over a project file is a worse
 * outcome than losing the customisation. The MCP server, whose operator named
 * the spec explicitly and whose process outlives the session, uses `strict`.
 */

export {
  DEFAULT_SPEC_PATH,
  SPEC_FILE_NAME,
  SpecResolutionError,
  SpecResolver,
  parseSpec,
  resolveSpec,
} from '@skillstate/core';
export type { ResolveSpecOptions, SpecResolution, SpecSource } from '@skillstate/core';
