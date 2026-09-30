/**
 * Whether the host ran a tool during a step.
 *
 * The tracker is the whole of the fix for a live failure, so these tests are
 * written against the event shape the host actually publishes rather than
 * against the tracker's own idea of it. The failing case was a paper-mode
 * session that emitted nineteen `{"state_patch": …, "action": "read
 * src/mod2.ts"}` turns in seven minutes without calling a single tool: the
 * loop counted steps and never asked whether a step had done anything, and the
 * ceiling that would have stopped it sits a hundred turns away, in memory, with
 * a restart having just zeroed it.
 */
import { describe, it, expect } from 'vitest';
import { ToolActivity, isToolPartUpdated } from '@skillstate/opencode';

/** A tool part event shaped as the host publishes it. */
function toolRan(sessionID: string, tool = 'read', status = 'completed'): unknown {
  return {
    type: 'message.part.updated',
    data: {
      sessionID,
      part: { type: 'tool', callID: `call_${tool}`, tool, state: { status } },
    },
  };
}

describe('isToolPartUpdated', () => {
  it('accepts a tool part and nothing else', () => {
    expect(isToolPartUpdated(toolRan('ses_1'))).toBe(true);
  });

  it('rejects a text part under the same event', () => {
    // `message.part.updated` carries every part kind. A text part is the A.4
    // output this whole mechanism exists to distinguish from a tool call, so
    // mistaking one for the other would defeat the guard in the exact turn it
    // is meant to catch.
    const text = {
      type: 'message.part.updated',
      data: { sessionID: 'ses_1', part: { type: 'text', text: '{"state_patch":{}}' } },
    };
    expect(isToolPartUpdated(text)).toBe(false);
  });

  it('rejects a foreign event, a missing session and a missing part', () => {
    expect(isToolPartUpdated({ type: 'session.step.ended', data: { sessionID: 'ses_1' } })).toBe(false);
    expect(isToolPartUpdated({ type: 'message.part.updated', data: { part: { type: 'tool' } } })).toBe(false);
    expect(isToolPartUpdated({ type: 'message.part.updated', data: { sessionID: 'ses_1' } })).toBe(false);
  });

  it('rejects a null payload, and a null part', () => {
    // `typeof null` is `'object'`, so both of these pass the first guard and
    // reach the property reads. Without the separate check each one throws
    // inside the event loop, where a throw ends the subscription for the rest
    // of the process's life.
    expect(isToolPartUpdated({ type: 'message.part.updated', data: null })).toBe(false);
    expect(isToolPartUpdated({ type: 'message.part.updated', data: { sessionID: 'ses_1', part: null } })).toBe(
      false,
    );
  });

  it('rejects what is not an object at all', () => {
    // The stream is a foreign source. `null` is the one value `typeof` reports
    // as an object, so the guard has to ask about it separately or the next
    // property read throws inside the event loop.
    expect(isToolPartUpdated(null)).toBe(false);
    expect(isToolPartUpdated(undefined)).toBe(false);
    expect(isToolPartUpdated('message.part.updated')).toBe(false);
  });
});

describe('ToolActivity', () => {
  it('reports no tool for a session that never called one', () => {
    const tools = new ToolActivity();
    expect(tools.tookTool('ses_1')).toBe(false);
  });

  it('reports a tool that ran during the step', () => {
    const tools = new ToolActivity();
    tools.note(toolRan('ses_1'));
    expect(tools.tookTool('ses_1')).toBe(true);
  });

  it('consumes the answer, so one tool cannot satisfy every later step', () => {
    // This is the property the guard stands on. A non-consuming tracker would
    // satisfy every step of a session from its first tool call, and a run that
    // stalled at file 80 would still read as "making progress" for ever.
    const tools = new ToolActivity();
    tools.note(toolRan('ses_1'));
    expect(tools.tookTool('ses_1')).toBe(true);
    expect(tools.tookTool('ses_1')).toBe(false);
  });

  it('counts a tool call that never finished, because a call is the step doing something', () => {
    // At `session.step.ended` the call has already been made. Requiring
    // `completed` would report a tool the user interrupted as no progress, and
    // stop a run that was in the middle of working.
    const tools = new ToolActivity();
    tools.note(toolRan('ses_1', 'shell', 'pending'));
    expect(tools.tookTool('ses_1')).toBe(true);
  });

  it('keeps sessions apart', () => {
    // Two sessions are live at once in a project — a subagent and its parent.
    // A tool in one is not a tool in the other, and crediting the wrong one
    // would keep a stalled session alive on its neighbour's work.
    const tools = new ToolActivity();
    tools.note(toolRan('ses_parent'));
    expect(tools.tookTool('ses_child')).toBe(false);
    expect(tools.tookTool('ses_parent')).toBe(true);
  });

  it('ignores every other event, so the whole stream can be folded in', () => {
    const tools = new ToolActivity();
    tools.note({ type: 'session.step.ended', data: { sessionID: 'ses_1' } });
    tools.note({ type: 'session.text.ended', data: { sessionID: 'ses_1', text: '{}' } });
    tools.note(null);
    expect(tools.size).toBe(0);
  });

  it('forgets everything on teardown', () => {
    const tools = new ToolActivity();
    tools.note(toolRan('ses_1'));
    expect(tools.size).toBe(1);
    tools.clear();
    expect(tools.size).toBe(0);
  });
});