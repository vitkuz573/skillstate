import { describe, it, expect } from 'vitest';
import {
  SessionRegistry,
  stateScopeFor,
  DEFAULT_SESSION_TTL_MS,
} from '@skillstate/opencode';

function registry(overrides: { now?: number } = {}) {
  let clock = overrides.now ?? 1_000;
  const reg = new SessionRegistry({ now: () => clock, ttlMs: 100, maxSessions: 32 });
  return {
    reg,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

describe('SessionRegistry — parsing the v2 event stream', () => {
  it('registers a root session from session.created without a parentID', () => {
    const { reg } = registry();
    const record = reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    expect(record).toEqual({ id: 'ses_root', parentID: null, seenAt: 1_000 });
    expect(reg.isSubAgent('ses_root')).toBe(false);
  });

  it('registers a sub-agent session from session.created with a parentID', () => {
    const { reg } = registry();
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child', parentID: 'ses_root' },
    });
    expect(reg.isSubAgent('ses_child')).toBe(true);
    expect(reg.get('ses_child')?.parentID).toBe('ses_root');
  });

  it('registers a forked session', () => {
    const { reg } = registry();
    reg.ingestEvent({
      type: 'session.forked',
      data: { sessionID: 'ses_fork', parentID: 'ses_root' },
    });
    expect(reg.isSubAgent('ses_fork')).toBe(true);
  });

  it('re-parents a session when a later event carries a different parentID', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_x' } });
    expect(reg.isSubAgent('ses_x')).toBe(false);
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_x', parentID: 'ses_root' },
    });
    expect(reg.isSubAgent('ses_x')).toBe(true);
  });

  it('forgets a session on session.deleted', () => {
    const { reg } = registry();
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child', parentID: 'ses_root' },
    });
    expect(reg.ingestEvent({ type: 'session.deleted', data: { sessionID: 'ses_child' } })).toBeNull();
    expect(reg.isSubAgent('ses_child')).toBe(false);
  });

  it('treats an unobserved session as a root session', () => {
    const { reg } = registry();
    expect(reg.isSubAgent('ses_never_seen')).toBe(false);
    expect(reg.get('ses_never_seen')).toBeUndefined();
  });

  it.each([
    ['null', null],
    ['a string', 'session.created'],
    ['a number', 7],
    ['a non-session event', { type: 'session.idle', data: { sessionID: 'ses_x' } }],
    ['an object with no type', { data: { sessionID: 'ses_x' } }],
    ['an object with a non-string type', { type: 7, data: { sessionID: 'ses_x' } }],
    ['a session event with no data', { type: 'session.created' }],
    ['non-object data', { type: 'session.created', data: 'nope' }],
    ['a missing sessionID', { type: 'session.created', data: { parentID: 'ses_root' } }],
    ['an empty sessionID', { type: 'session.created', data: { sessionID: '' } }],
    ['a non-string sessionID', { type: 'session.created', data: { sessionID: 42 } }],
  ])('ignores %s', (_label, event) => {
    const { reg } = registry();
    expect(reg.ingestEvent(event)).toBeNull();
    expect(reg.size).toBe(0);
  });

  it('treats an empty or non-string parentID as a root session', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: '' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b', parentID: 5 } });
    expect(reg.isSubAgent('ses_a')).toBe(false);
    expect(reg.isSubAgent('ses_b')).toBe(false);
  });
});

describe('SessionRegistry — the session tree', () => {
  it('resolves the root of a nested sub-agent chain', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_a', parentID: 'ses_root' },
    });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b', parentID: 'ses_a' } });
    expect(reg.rootOf('ses_b')).toBe('ses_root');
    expect(reg.rootOf('ses_a')).toBe('ses_root');
    expect(reg.rootOf('ses_root')).toBe('ses_root');
    expect(reg.rootOf('ses_unknown')).toBe('ses_unknown');
  });

  it('stops walking when a parent id was never registered', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_ghost' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    expect(reg.descendantsOf('ses_root')).toEqual([]);
  });

  it('descendantsOf terminates on a parent cycle instead of hanging', () => {
    const { reg } = registry();
    // The cycle does not contain the queried ancestor, so the walk has to
    // detect the loop rather than finding the ancestor on the first hop.
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_b' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b', parentID: 'ses_a' } });
    expect(reg.descendantsOf('ses_root')).toEqual([]);
  });

  it('terminates on a parent cycle instead of hanging', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_b' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b', parentID: 'ses_a' } });
    expect(['ses_a', 'ses_b']).toContain(reg.rootOf('ses_a'));
  });

  it('lists every descendant of a root session, sorted', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_z', parentID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_deep', parentID: 'ses_a' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_other' } });
    expect(reg.descendantsOf('ses_root')).toEqual(['ses_a', 'ses_deep', 'ses_z']);
  });

  it('lists descendants of a sub-agent as that sub-agent subtree', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a', parentID: 'ses_root' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b', parentID: 'ses_a' } });
    expect(reg.descendantsOf('ses_a')).toEqual(['ses_b']);
  });

  it('lists sessions oldest-observed first', () => {
    const { reg, advance } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_second' } });
    advance(10);
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_first' } });
    expect(reg.list().map((r) => r.id)).toEqual(['ses_second', 'ses_first']);
  });

  it('orders equal timestamps by id so the listing is stable', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a' } });
    expect(reg.list().map((r) => r.id)).toEqual(['ses_a', 'ses_b']);
  });

  it('clears every session', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.clear();
    expect(reg.size).toBe(0);
  });
});

describe('SessionRegistry — eviction', () => {
  it('drops sessions idle for longer than the TTL', () => {
    const { reg, advance } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_old' } });
    advance(150);
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_new' } });
    expect(reg.size).toBe(1);
    expect(reg.get('ses_old')).toBeUndefined();
  });

  it('enforces the size cap by dropping the least recently seen', () => {
    let clock = 1_000;
    const reg = new SessionRegistry({ now: () => clock, ttlMs: 100_000, maxSessions: 3 });
    for (const [index, id] of ['ses_1', 'ses_2', 'ses_3', 'ses_4'].entries()) {
      reg.ingestEvent({ type: 'session.created', data: { sessionID: id } });
      clock += 1;
      expect(reg.size).toBe(Math.min(index + 1, 3));
    }
    expect(reg.get('ses_1')).toBeUndefined();
    expect(reg.get('ses_4')).toBeDefined();
  });

  it('breaks a same-timestamp size-cap tie by id', () => {
    const reg = new SessionRegistry({ now: () => 5, ttlMs: 1_000, maxSessions: 1 });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_b' } });
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_a' } });
    expect([...reg.list().map((r) => r.id)]).toEqual(['ses_b']);
  });

  it('evicts on demand and defaults every option when none are injected', () => {
    const reg = new SessionRegistry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    expect(reg.size).toBe(1);
    reg.evict();
    expect(reg.size).toBe(1);
    expect(DEFAULT_SESSION_TTL_MS).toBeGreaterThan(0);
  });
});

describe('stateScopeFor', () => {
  it('gives a root session the shared project scope', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root1234' } });
    expect(stateScopeFor(reg, 'ses_root1234')).toBe('');
  });

  it('scopes a sub-agent as <parentPrefix>-<childPrefix>', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1234', parentID: 'ses_root' },
    });
    expect(stateScopeFor(reg, 'ses_child1234')).toBe('ses_root-ses_child1234');
  });

  it('falls back to the child prefix when the parent id sanitizes to nothing', () => {
    const { reg } = registry();
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1234', parentID: '!!!!!!!!' },
    });
    expect(stateScopeFor(reg, 'ses_child1234')).toBe('ses_child1234');
  });

  it('falls back to the parent prefix when the child id sanitizes to nothing', () => {
    const { reg } = registry();
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: '!!!!!!!!', parentID: 'ses_root' },
    });
    expect(stateScopeFor(reg, '!!!!!!!!')).toBe('ses_root');
  });

  it('never collapses two siblings that share an id prefix', () => {
    // Regression: truncating to an 8-character prefix mapped both of these
    // onto one state file, so sibling sub-agents silently overwrote each
    // other's notes.
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child1111', parentID: 'ses_root' },
    });
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: 'ses_child2222', parentID: 'ses_root' },
    });
    expect(stateScopeFor(reg, 'ses_child1111')).not.toBe(
      stateScopeFor(reg, 'ses_child2222'),
    );
  });

  it('collapses a hostile id into a safe single segment', () => {
    const { reg } = registry();
    reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_root' } });
    reg.ingestEvent({
      type: 'session.created',
      data: { sessionID: '../../etc/passwd', parentID: 'ses_root' },
    });
    const scope = stateScopeFor(reg, '../../etc/passwd');
    expect(scope).not.toContain('/');
    expect(scope).not.toContain('..');
  });
});
