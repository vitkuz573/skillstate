/**
 * @non-paper secret redaction for logs, prompts, and persisted reports.
 *
 * The paper core never sees credentials, but the @non-paper adapters and
 * trackers shuttle raw LLM text through logs and state files. `redactSecrets`
 * is a fail-closed scrubber: anything shaped like a credential is replaced
 * with `[REDACTED]` before the text leaves the process boundary.
 *
 * Covered shapes:
 * - AWS access keys (`AKIA` + 16 uppercase alphanumerics);
 * - GitHub tokens (`ghp_` + alphanumerics);
 * - OpenAI-style keys (`sk-` + alphanumerics/dashes/underscores);
 * - `Bearer <token>` authorisation headers (scheme is kept, token scrubbed);
 * - PEM private-key blocks (`-----BEGIN … PRIVATE KEY-----` … `-----END …`).
 *
 * Pure string function, zero dependencies, Node >= 20, ESM.
 */

/** Replacement marker for anything shaped like a secret. */
export const REDACTED = '[REDACTED]';

const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const AWS_ACCESS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const GITHUB_TOKEN = /\bghp_[A-Za-z0-9_]+/g;
const OPENAI_KEY = /\bsk-[A-Za-z0-9_-]+/g;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9\-._~+/=]{8,}/g;

/**
 * Replace every credential-shaped span in `text` with `[REDACTED]`
 * (`Bearer <token>` keeps the scheme: `Bearer [REDACTED]`). Pure: the
 * input string is never mutated.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, REDACTED)
    .replace(AWS_ACCESS_KEY, REDACTED)
    .replace(GITHUB_TOKEN, REDACTED)
    .replace(OPENAI_KEY, REDACTED)
    .replace(BEARER_TOKEN, 'Bearer [REDACTED]');
}
