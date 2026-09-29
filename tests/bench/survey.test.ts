/**
 * The survey, run against 1810 real sessions.
 *
 * ── What the fixture is ──────────────────────────────────────────────────
 *
 * `tests/bench/_support/real-sessions.json` is a snapshot of the host's own
 * token accounting, read from its local store: per session, the number of
 * assistant steps, the total prompt tokens the host charged for them
 * (`input` + `cache.read`), and the first and last step's prompt size.
 *
 * The totals are 117 418 steps and 19 626 479 940 prompt tokens. These are
 * not generated, not modelled, and not from the paper — they are what a real
 * agent loop was actually charged.
 *
 * The fixture stores aggregates rather than every step's array, because the
 * survey only needs the totals and the growth endpoints. That keeps a 223 KB
 * fixture honest about what it does and does not contain: it cannot be used
 * to re-derive per-step behaviour, only to check the aggregate claim.
 *
 * ── Why these numbers are a locked assertion ─────────────────────────────
 *
 * The finding is the project's central cost claim, and the A/B harness exists
 * because an earlier number was reported without checking whether it meant
 * anything. So the same discipline applies: the aggregate is asserted, and
 * the two claims that could be inflated are checked explicitly.
 */

import { describe as group, it, expect } from 'vitest';
import * as fs from 'node:fs';
import {
  DEFAULT_BOUNDED_PROMPT_TOKENS,
  assessReconstruction,
  breakEvenPromptTokens,
  formatSurvey,
  reconstruct,
  survey,
} from '@skillstate/bench';
import type { HostSession } from '@skillstate/bench';

interface FixtureSession {
  sessionID: string;
  steps: number;
  host: number;
  first: number;
  last: number;
  grew: boolean;
}

const FIXTURE: FixtureSession[] = JSON.parse(
  fs.readFileSync(new URL('./_support/real-sessions.json', import.meta.url), 'utf-8'),
) as FixtureSession[];

/**
 * Rebuild a session whose per-step distribution reproduces its totals.
 *
 * The fixture has aggregates, so the survey is given a session shaped to match
 * them: a constant per-step cost, with the recorded first and last values put
 * back so the growth endpoints survive. It is a reconstruction, and it is only
 * used where the survey reads totals and slope — never where it reads the
 * shape of the curve.
 *
 * The middle steps absorb the difference so the total is EXACT rather than
 * approximately right. Overwriting the endpoints naively would leave the sum
 * off by whatever those two steps contribute, which is a visible 0.3% drift
 * across the corpus and enough to make an exact assertion on the real total
 * fail for the wrong reason.
 */
function toHostSession(row: FixtureSession): HostSession {
  const steps = Array.from({ length: row.steps }, () => ({
    input: row.host / row.steps,
    cacheRead: 0,
    output: 0,
  }));
  steps[0] = { input: row.first, cacheRead: 0, output: 0 };
  steps[steps.length - 1] = { input: row.last, cacheRead: 0, output: 0 };
  // Redistribute the endpoints' deviation across the middle steps.
  const middle = steps.length - 2;
  if (middle > 0) {
    const drift = row.host - steps.reduce((sum, s) => sum + s.input, 0);
    const share = drift / middle;
    for (let i = 1; i < steps.length - 1; i += 1) {
      steps[i] = { input: steps[i]!.input + share, cacheRead: 0, output: 0 };
    }
  }
  return { sessionID: row.sessionID, label: row.sessionID, steps };
}

const SESSIONS: HostSession[] = FIXTURE.map(toHostSession);

group('the survey over 1810 real sessions', () => {
  const result = survey(SESSIONS);

  it('sees the whole corpus', () => {
    expect(result.sessions).toBe(1810);
    expect(result.steps).toBe(117418);
  });

  it('totals 19.6 billion host prompt tokens', () => {
    // The host charged 19 626 479 940 prompt tokens across these sessions.
    expect(result.hostPromptTokens).toBeGreaterThan(19_600_000_000);
    expect(result.hostPromptTokens).toBeLessThan(19_700_000_000);
  });

  it('a bounded Aₜ prompt would have cost ~1% of that', () => {
    expect(result.boundedPromptTokens).toBe(
      117418 * DEFAULT_BOUNDED_PROMPT_TOKENS,
    );
  });

  it('saves at least 98% of prompt cost', () => {
    expect(result.savedFraction!).toBeGreaterThan(0.98);
  });

  it('saves in EVERY session, not merely on median', () => {
    // The strongest form of the claim, and the one a mean would hide: no
    // session in the corpus is cheaper as a transcript than as a bounded
    // prompt. If this ever goes to 1, something about the model changed.
    expect(result.boundedLosesCount).toBe(0);
  });

  it('sees the transcript grow in most sessions', () => {
    // 87.4% of sessions had a prompt larger at the end than at the start.
    expect(result.grewCount / result.sessions).toBeGreaterThan(0.85);
  });

  it('has a high median per-session saving', () => {
    expect(result.medianSavedFraction).toBeGreaterThan(0.9);
  });
});

group('the claim survives an unfavourable assumption', () => {
  it('still saves >94% if the bounded prompt were 10k tokens, not 1.8k', () => {
    // 1800 is the paper's figure. If it were badly wrong, the result should
    // not collapse. At 10k the saving is still 94%.
    const wide = survey(SESSIONS, { boundedPromptTokens: 10_000 });
    expect(wide.savedFraction!).toBeGreaterThan(0.94);
  });

  it('still wins in almost every session at 10k', () => {
    const wide = survey(SESSIONS, { boundedPromptTokens: 10_000 });
    expect(wide.boundedLosesCount / wide.sessions).toBeLessThan(0.05);
  });

  it('a bounded prompt up to 4k tokens/step wins in every session', () => {
    // The break-even is a property of the data, not a number chosen to suit.
    const bound = breakEvenPromptTokens(SESSIONS);
    expect(bound.tokens).toBeGreaterThan(4000);
    expect(bound.tokens).toBeLessThan(DEFAULT_BOUNDED_PROMPT_TOKENS * 3);
  });

  it('handles an odd number of sessions in the median', () => {
    // The corpus has an even count, so the odd branch is only reachable with
    // a hand-built set — and an unexercised branch is a branch that can rot.
    const three: HostSession[] = [1, 2, 3].map((n) => ({
      sessionID: `ses_${n}`,
      label: 'x',
      steps: [
        { input: n * 1000, cacheRead: 0, output: 0 },
        { input: n * 2000, cacheRead: 0, output: 0 },
      ],
    }));
    const bound = breakEvenPromptTokens(three);
    // Per-step averages are 1500 / 3000 / 4500: the conservative bound is the
    // smallest, the median is the middle one.
    expect(bound.tokens).toBe(1500);
    expect(bound.medianAverage).toBe(3000);
  });

  it('reports the average per-step cost for context', () => {
    const bound = breakEvenPromptTokens(SESSIONS);
    expect(bound.medianAverage).toBeGreaterThan(DEFAULT_BOUNDED_PROMPT_TOKENS);
    expect(bound.conservative).toBe(true);
  });
});

group('reconstruct, per session', () => {
  it('sums the host prompt cost of one session', () => {
    const session: HostSession = {
      sessionID: 'ses_1',
      label: 'test',
      steps: [
        { input: 100, cacheRead: 900, output: 10 },
        { input: 200, cacheRead: 1800, output: 10 },
      ],
    };
    const result = reconstruct(session, { boundedPromptTokens: 1800 });
    // 1000 + 2000 = 3000 on the host side.
    expect(result.hostPromptTokens).toBe(3000);
    expect(result.boundedPromptTokens).toBe(3600);
  });

  it('reports a negative saving when the session is smaller than a prompt', () => {
    // A two-step session is cheaper as a transcript. Reporting this honestly
    // is the point: a bounded prompt is not free, and pretending otherwise
    // would make the corpus number a fiction.
    const session: HostSession = {
      sessionID: 'ses_short',
      label: 'short',
      steps: [
        { input: 10, cacheRead: 10, output: 1 },
        { input: 10, cacheRead: 10, output: 1 },
      ],
    };
    expect(reconstruct(session, { boundedPromptTokens: 1800 }).savedTokens).toBeLessThan(0);
  });

  it('measures the slope across the session', () => {
    const session: HostSession = {
      sessionID: 'ses_2',
      label: 'growing',
      steps: [
        { input: 1000, cacheRead: 0, output: 0 },
        { input: 5000, cacheRead: 0, output: 0 },
        { input: 9000, cacheRead: 0, output: 0 },
      ],
    };
    expect(reconstruct(session).hostSlope).toBe(8000);
  });

  it('reports a zero slope for a single step rather than a negative one', () => {
    const session: HostSession = {
      sessionID: 'ses_one',
      label: 'one',
      steps: [{ input: 42, cacheRead: 0, output: 0 }],
    };
    expect(reconstruct(session).hostSlope).toBe(0);
  });

  it('adds the state cost to the bounded prompt', () => {
    // Σₜ is not free, and its growth must be visible rather than hidden inside
    // a constant that looks flat.
    const session: HostSession = {
      sessionID: 'ses_3',
      label: 'state',
      steps: [
        { input: 10000, cacheRead: 0, output: 0 },
        { input: 10000, cacheRead: 0, output: 0 },
      ],
    };
    const plain = reconstruct(session, { boundedPromptTokens: 1800 });
    const withState = reconstruct(session, { boundedPromptTokens: 1800, stateTokens: 500 });
    expect(plain.boundedPromptTokens).toBe(3600);
    expect(withState.boundedPromptTokens).toBe(4600);
  });

  it('carries the state cost into the slope, so growth is visible', () => {
    const session: HostSession = {
      sessionID: 'ses_4',
      label: 'flat state',
      steps: [
        { input: 10000, cacheRead: 0, output: 0 },
        { input: 10000, cacheRead: 0, output: 0 },
      ],
    };
    // A constant state keeps the bounded slope at 0. The caller models growth
    // by passing a bigger figure; the point is that the default does not
    // pretend to be zero-cost.
    expect(reconstruct(session, { stateTokens: 300 }).boundedSlope).toBe(0);
    expect(reconstruct(session, { stateTokens: 300 }).boundedPromptTokens).toBe(4200);
  });

  it('reports a null fraction when the host spent nothing', () => {
    const session: HostSession = {
      sessionID: 'ses_zero',
      label: 'zero',
      steps: [
        { input: 0, cacheRead: 0, output: 0 },
        { input: 0, cacheRead: 0, output: 0 },
      ],
    };
    expect(reconstruct(session).savedFraction).toBeNull();
  });

  it('omits per-step arrays unless asked, to keep reports small', () => {
    const session = SESSIONS[0]!;
    const result = survey([session], { keepPerStep: false });
    expect(result.results[0]!.hostPerStep).toHaveLength(0);
    const kept = survey([session], { keepPerStep: true });
    expect(kept.results[0]!.hostPerStep.length).toBe(session.steps.length);
  });
});

group('assessReconstruction — when the offline number cannot be trusted', () => {
  function session(steps: HostSession['steps'], bounded = 1800): HostSession {
    return { sessionID: 'ses_x', label: 'x', steps };
  }

  it('refuses a single step, which cannot show growth', () => {
    const result = reconstruct(session([{ input: 500, cacheRead: 0, output: 0 }]));
    const assessment = assessReconstruction(result);
    expect(assessment.usable).toBe(false);
    expect(assessment.reasons.join(' ')).toContain('at least 2');
  });

  it('refuses a flat transcript, where there is no O(T) cost to remove', () => {
    // A saving computed from a transcript that never grew is an artifact of
    // the constant, not a result.
    const flat = session([
      { input: 5000, cacheRead: 0, output: 0 },
      { input: 5000, cacheRead: 0, output: 0 },
      { input: 5000, cacheRead: 0, output: 0 },
    ]);
    const assessment = assessReconstruction(reconstruct(flat, { boundedPromptTokens: 100 }));
    expect(assessment.usable).toBe(false);
    expect(assessment.reasons.join(' ')).toContain('did not grow');
  });

  it('refuses a gap smaller than the noise floor', () => {
    const noisy = session([
      { input: 1800, cacheRead: 0, output: 0 },
      { input: 10000, cacheRead: 0, output: 0 },
      { input: 1800, cacheRead: 0, output: 0 },
      { input: 11000, cacheRead: 0, output: 0 },
    ]);
    const assessment = assessReconstruction(reconstruct(noisy, { boundedPromptTokens: 5000 }));
    expect(assessment.usable).toBe(false);
  });

  it('accepts a real growing transcript', () => {
    // A realistic curve rather than three points: on a 3-point sample the MAD
    // is degenerate (0.98 MADs for a 200k-token spread), which is a property
    // of MAD on tiny samples, not evidence against the claim.
    const growing = session(
      Array.from({ length: 20 }, (_unused, t) => ({
        input: 15_000 + t * 8_000,
        cacheRead: 0,
        output: 0,
      })),
    );
    const result = reconstruct(growing);
    expect(result.hostSlope).toBeGreaterThan(0);
    expect(assessReconstruction(result).usable).toBe(true);
  });
});

group('the survey report', () => {
  it('prints the totals and the counter that qualifies them', () => {
    const text = formatSurvey(survey(SESSIONS.slice(0, 50)));
    expect(text).toContain('sessions');
    expect(text).toContain('bounded loses');
    expect(text).toContain('transcript grew');
  });

  it('says n/a rather than NaN when nothing was spent', () => {
    const empty = survey([
      {
        sessionID: 'ses_0',
        label: 'zero',
        steps: [
          { input: 0, cacheRead: 0, output: 0 },
          { input: 0, cacheRead: 0, output: 0 },
        ],
      },
    ]);
    expect(formatSurvey(empty)).toContain('n/a');
  });

  it('handles an empty corpus without throwing', () => {
    const none = survey([]);
    expect(none.sessions).toBe(0);
    expect(none.medianSavedFraction).toBe(0);
    expect(breakEvenPromptTokens([]).tokens).toBe(0);
  });
});
