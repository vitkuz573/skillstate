/**
 * @non-paper — OPTIONAL instrumentation helpers, NOT part of the paper.
 *
 * Nothing in this module appears in arXiv 2608.26263v3. The paper's §4.3
 * methodology measures prompts in raw string chars (Average Prompt Size =
 * mean char length per call, Total Token Cost = cumulative burn) and reports
 * no tokenizer heuristic and no dollar pricing. Import from here only when
 * you explicitly want a rough, clearly-labelled estimate outside the
 * paper-exact baseline in `./token-tracker.js`.
 */

/** Pluggable character-to-token estimator (heuristic, never exact). */
export interface TokenCounter {
  /** Roughly estimate the tokens in `text`. */
  count(text: string): number;
}

/**
 * @non-paper rough heuristic: 1 token ≈ 4 chars, rounded up.
 *
 * Kept for backward compatibility of ad-hoc estimates only. Do NOT use it
 * for paper §4.3 metrics — those are measured in chars (see `TokenTracker`).
 * Empty text costs zero.
 */
export class CharDiv4Counter implements TokenCounter {
  count(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return Math.ceil(text.length / 4);
  }
}

/**
 * @non-paper estimated dollar savings of state prompts vs the conversation
 * baseline, from measured char counts (e.g. `TokenTracker.compareWithBaseline`).
 *
 * This is a back-of-the-envelope estimate, NOT a paper metric: the paper
 * reports no pricing. `usdPerMillionChars` defaults to 3 (a placeholder
 * rate, not a paper figure). Returns 0 when there is nothing to save.
 */
export function estimateCostSavings(
  conversationChars: number,
  stateChars: number,
  usdPerMillionChars = 3,
): number {
  const saved = conversationChars - stateChars;
  if (saved <= 0) {
    return 0;
  }
  return (saved * usdPerMillionChars) / 1_000_000;
}
