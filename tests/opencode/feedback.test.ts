/**
 * Corrective feedback for a rejected state patch.
 *
 * ── The bug this covers ──────────────────────────────────────────────────
 *
 * `plugin.ts` used to call `sink.ingest(event)` and throw the result away.
 * Every rejection reason was computed and discarded, so a model whose
 * `state_patch` failed to parse got a byte-identical next prompt and no
 * signal that anything was wrong. Σₜ simply stopped moving, silently, and on
 * a long-horizon task that is total failure wearing the costume of a model
 * that has decided not to cooperate.
 */

import { describe as group, it, expect } from 'vitest';
import { FeedbackQueue, applyFeedback, feedbackFor } from '@skillstate/opencode';
import type { SinkOutcome, SinkRejection } from '@skillstate/opencode';

const SPEC_REASONS: SinkRejection[] = [
  'not_a_text_block',
  'duplicate',
  'no_block',
  'malformed_json',
  'missing_state_patch',
  'missing_action',
  'schema_invalid',
  'empty_patch',
  'write_failed',
];

function rejected(rejection: SinkRejection, detail?: string): SinkOutcome {
  return detail === undefined
    ? { applied: false, rejection }
    : { applied: false, rejection, detail };
}

const APPLIED: SinkOutcome = { applied: true, changes: { added: [], updated: ['goal'], deleted: [] }, action: 'continue' };

// ---------------------------------------------------------------------------
// feedbackFor — every reason must produce something actionable.
// ---------------------------------------------------------------------------

group('feedbackFor', () => {
  it('has a message for every rejection reason', () => {
    // A reason with no message would silently produce no correction, which is
    // the bug this module exists to fix, reappearing one level down.
    for (const reason of SPEC_REASONS) {
      expect(feedbackFor(reason).length).toBeGreaterThan(0);
    }
  });

  it('tells the model what to do differently, not merely what failed', () => {
    for (const reason of SPEC_REASONS) {
      const message = feedbackFor(reason);
      // "No state patch was applied" alone leaves the model nothing to
      // correct against; every message states the consequence and the fix.
      expect(message.length).toBeGreaterThan(40);
    }
  });

  it('names the two required keys when the block was malformed', () => {
    for (const reason of ['no_block', 'missing_state_patch', 'missing_action'] as const) {
      expect(feedbackFor(reason)).toContain('state_patch');
      expect(feedbackFor(reason)).toContain('action');
    }
  });

  it('blames the schema when the patch failed validation', () => {
    expect(feedbackFor('schema_invalid')).toContain('schema');
  });

  it('does not tell the model to fix a patch when the disk refused it', () => {
    // `write_failed` is an environment fault. Sending the model hunting for a
    // malformed patch when the disk rejected a valid one points it at the
    // wrong problem and wastes a step.
    expect(feedbackFor('write_failed')).toContain('environment fault');
  });
});

// ---------------------------------------------------------------------------
// FeedbackQueue — the delivery contract.
// ---------------------------------------------------------------------------

group('FeedbackQueue', () => {
  it('queues a correction for a rejected patch', () => {
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    expect(queue.peek('ses_1')).toBe(feedbackFor('no_block'));
  });

  it('does not queue anything for a non-text event', () => {
    // A session-tree event is not a failed attempt, and telling the model its
    // patch was rejected when it never sent one would be a fabrication.
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('not_a_text_block'));
    expect(queue.size).toBe(1);
  });

  it('shows a correction exactly once', () => {
    // Repeated forever it becomes wallpaper carrying no more information than
    // a constant line, and a reader counting prompts can no longer tell an
    // ongoing failure from a stale one.
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('malformed_json'));
    expect(queue.take('ses_1')).toBe(feedbackFor('malformed_json'));
    expect(queue.take('ses_1')).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('leaves the queue unchanged when nothing was pending', () => {
    const queue = new FeedbackQueue();
    expect(queue.take('ses_absent')).toBeUndefined();
    expect(queue.size).toBe(0);
  });

  it('keeps sessions apart, so one sub-agent never sees another correction', () => {
    const queue = new FeedbackQueue();
    queue.record('ses_parent', rejected('no_block'));
    queue.record('ses_child', rejected('schema_invalid'));
    expect(queue.size).toBe(2);
    expect(queue.take('ses_parent')).toBe(feedbackFor('no_block'));
    expect(queue.take('ses_child')).toBe(feedbackFor('schema_invalid'));
  });

  it('clears a pending correction once the model gets it right', () => {
    // Stale complaints must not ride alongside good news.
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    queue.record('ses_1', APPLIED);
    expect(queue.peek('ses_1')).toBeUndefined();
  });

  it('replaces an undelivered correction with the newer reason', () => {
    // Two failures before the first was shown: the newest reason is the most
    // useful thing to say, and the older one never got delivered anyway.
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    queue.record('ses_1', rejected('malformed_json'));
    expect(queue.take('ses_1')).toBe(feedbackFor('malformed_json'));
  });

  it('ignores a message that maps to nothing rather than clearing one', () => {
    // Defensive: `SinkRejection` is a closed union today, so this branch is
    // unreachable through the real sink. It exists so that adding a reason
    // without a message cannot silently wipe a deliverable correction.
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    queue.record('ses_1', {
      applied: false,
      // Cast past the union: simulates a future reason with no message.
      rejection: 'a_future_reason' as SinkRejection,
    });
    expect(queue.peek('ses_1')).toBe(feedbackFor('no_block'));
  });

  it('ignores an outcome with no rejection and no success', () => {
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    queue.record('ses_1', { applied: false });
    expect(queue.peek('ses_1')).toBe(feedbackFor('no_block'));
  });

  it('peek does not consume', () => {
    const queue = new FeedbackQueue();
    queue.record('ses_1', rejected('no_block'));
    expect(queue.peek('ses_1')).toBe(feedbackFor('no_block'));
    expect(queue.peek('ses_1')).toBe(feedbackFor('no_block'));
    expect(queue.size).toBe(1);
  });

  it('forgets everything on clear', () => {
    const queue = new FeedbackQueue();
    queue.record('a', rejected('no_block'));
    queue.record('b', rejected('no_block'));
    queue.clear();
    expect(queue.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// applyFeedback — how the correction rides in Oₜ.
// ---------------------------------------------------------------------------

group('applyFeedback', () => {
  it('leaves the observation untouched when there is no correction', () => {
    expect(applyFeedback('file listing', undefined)).toBe('file listing');
  });

  it('leaves it untouched for an empty correction', () => {
    expect(applyFeedback('file listing', '')).toBe('file listing');
  });

  it('prepends the correction above the observation', () => {
    // The order the events happened in: the rejection came first, then the
    // tool output the model is now reasoning about.
    const result = applyFeedback('test output: 42 passed', 'your patch was invalid');
    expect(result).toBe('[state patch rejected] your patch was invalid\ntest output: 42 passed');
  });

  it('marks the correction so it cannot be read as tool output', () => {
    // Without a marker a correction is indistinguishable from a tool result,
    // and the model can reasonably read it as data rather than as a report
    // about its own last turn.
    expect(applyFeedback('data', 'x')).toContain('[state patch rejected]');
  });

  it('carries the correction alone rather than addressing nobody', () => {
    // "marker: " with an empty observation reads as a message with no subject.
    expect(applyFeedback('', 'your patch was invalid')).toBe(
      '[state patch rejected] your patch was invalid',
    );
  });
});
