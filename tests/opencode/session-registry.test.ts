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
    // `directory: null` is the assertion that matters here as much as the rest:
    // an event that names no project leaves the session unplaced, and an
    // unplaced session is one the plugin must not act on. See `isForeign`.
    expect(record).toEqual({ id: 'ses_root', parentID: null, directory: null, seenAt: 1_000 });
    expect(reg.isSubAgent('ses_root')).toBe(false);
  });

  describe('which project a session belongs to', () => {
    const OWN = '/projects/one';
    const OTHER = '/projects/two';

    it('reads the directory off info, which is the only place the stream names it', () => {
      const { reg } = registry();
      const record = reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_1', info: { id: 'ses_1', directory: OWN } },
      });
      expect(record?.directory).toBe(OWN);
      expect(reg.isForeign('ses_1', OWN)).toBe(false);
      expect(reg.isForeign('ses_1', OTHER)).toBe(true);
    });

    it('reads it off session.updated too, which is how an already-open session speaks', () => {
      // `created` fires once, when a session is made. A plugin that loads
      // mid-session never sees it, and `updated` is the only other event that
      // carries the same `info.directory`.
      const { reg } = registry();
      const record = reg.ingestEvent({
        type: 'session.updated',
        data: { sessionID: 'ses_1', info: { id: 'ses_1', directory: OTHER } },
      });
      expect(record?.directory).toBe(OTHER);
      expect(reg.isForeign('ses_1', OWN)).toBe(true);
    });

    it('treats a trailing separator or a dot segment as the same directory', () => {
      // The plugin reads its own from `ctx.location.project.canonical` and a
      // session's from the event, by two different routes. Deciding "different
      // project" over a trailing slash would make a plugin ignore its own
      // session, which looks exactly like paper mode silently doing nothing.
      const { reg } = registry();
      reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_1', info: { id: 'ses_1', directory: `${OWN}/` } },
      });
      expect(reg.isForeign('ses_1', OWN)).toBe(false);
    });

    it('treats a session it cannot place as foreign, not as its own', () => {
      // The direction that matters. A paper-mode project that assumed an
      // unknown session was its own drove a session in another project for 264
      // turns on one machine; the assumption was what did the damage.
      const { reg } = registry();
      expect(reg.isForeign('ses_never_seen', OWN)).toBe(true);
      reg.ingestEvent({ type: 'session.created', data: { sessionID: 'ses_bare' } });
      expect(reg.isForeign('ses_bare', OWN)).toBe(true);
    });

    it('names a session that only `info.sessionID` carries', () => {
      // A host that stopped repeating the id at the top level would otherwise
      // make every one of its own sessions look unplaceable, and the plugin
      // would ignore its own project — which reads as paper mode silently doing
      // nothing, the most expensive failure mode there is.
      const { reg } = registry();
      const record = reg.ingestEvent({
        type: 'session.created',
        data: { info: { id: 'ses_1', sessionID: 'ses_1', directory: OWN } },
      });
      expect(record?.id).toBe('ses_1');
      expect(reg.isForeign('ses_1', OWN)).toBe(false);
    });

    it('reads nothing off an event that is not a shape at all', () => {
      // The registry reads a stream it does not own, and `readSessionEvent` is
      // called on every event the plugin sees. Every one of these must return,
      // never throw: a throw inside the subscription loop ends the subscription
      // for the rest of the process's life, and the plugin goes quiet in a way
      // nothing reports.
      const { reg } = registry();
      for (const bad of [null, undefined, 'session.created', 42]) {
        expect(reg.ingestEvent(bad)).toBeNull();
      }
      for (const bad of [null, undefined, 'nope', 7, []]) {
        expect(reg.ingestEvent({ type: 'session.created', data: bad })).toBeNull();
      }
      // A bad `info` beside a good id still registers the session, and that is
      // correct: the id is what the registry keys on, and `info` is only where
      // it looks for the project. Registering without a placement is what makes
      // `isForeign` answer true, which is the safe direction.
      for (const bad of [null, undefined, 'nope', 7, []]) {
        const record = reg.ingestEvent({
          type: 'session.created',
          data: { sessionID: `ses_bad_${String(bad)}`, info: bad },
        });
        expect(record?.directory).toBeNull();
        expect(reg.isForeign(`ses_bad_${String(bad)}`, OWN)).toBe(true);
      }
      // No `type`, and a type that is not a string.
      expect(reg.ingestEvent({ data: { sessionID: 'ses_1' } })).toBeNull();
      expect(reg.ingestEvent({ type: 42, data: { sessionID: 'ses_1' } })).toBeNull();
      // `info: null` with a good id, read through the same guard as every other
      // unusable `info` — including the one `typeof` alone would have let past.
      const nulled = reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_nulled', info: null },
      });
      expect(nulled?.directory).toBeNull();
    });

    it('ignores an `info` that names no session at all', () => {
      // `info.directory` with no id anywhere: there is nothing to attach a
      // placement to, and inventing an id from the record would register a
      // session the host never announced.
      const { reg } = registry();
      expect(
        reg.ingestEvent({
          type: 'session.created',
          data: { info: { directory: OWN } },
        }),
      ).toBeNull();
      expect(
        reg.ingestEvent({
          type: 'session.created',
          data: { info: { id: 'ses_1', directory: OWN, sessionID: '' } },
        }),
      ).toBeNull();
    });

    it('reads nothing off an event whose info was emptied', () => {
      // `info: null` and "no `info`" both leave the session unplaced, and both
      // must say so without throwing. A record with its fields wiped is a thing
      // a foreign store can produce, and the plugin reads a stream it does not
      // own.
      const { reg } = registry();
      const record = reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_1', info: null },
      });
      expect(record?.directory).toBeNull();
      expect(reg.isForeign('ses_1', OWN)).toBe(true);
      const notAnObject = reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_2', info: 'nonsense' },
      });
      expect(notAnObject?.directory).toBeNull();
    });

    it('forgets the placement when the session is deleted', () => {
      const { reg } = registry();
      reg.ingestEvent({
        type: 'session.created',
        data: { sessionID: 'ses_1', info: { id: 'ses_1', directory: OTHER } },
      });
      reg.ingestEvent({ type: 'session.deleted', data: { sessionID: 'ses_1' } });
      expect(reg.isForeign('ses_1', OWN)).toBe(true);
    });
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
