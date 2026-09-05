import { describe, it, expect } from 'vitest';
import {
  skipWsAndComments,
  scanObject,
  scanArray,
  findTopLevelObject,
  stripJsonc,
  parseJsonc,
  insertObjectEntry,
  removeObjectEntry,
  hasArrayStringEntry,
  insertArrayStringEntry,
  removeArrayStringEntry,
} from '@skillstate/cli';

describe('skipWsAndComments', () => {
  it('skips whitespace', () => {
    expect(skipWsAndComments('  \t\n x', 0)).toBe(5);
  });

  it('skips line comments up to the newline', () => {
    expect(skipWsAndComments('// hi\nx', 0)).toBe(6);
  });

  it('skips block comments to the terminator', () => {
    expect(skipWsAndComments('/* a * b */x', 0)).toBe(11);
  });

  it('stops at end of text on unterminated comments', () => {
    expect(skipWsAndComments('// forever', 0)).toBe(10);
    expect(skipWsAndComments('/* forever', 0)).toBe(10);
  });

  it('returns the index when nothing is skipped', () => {
    expect(skipWsAndComments('"x"', 0)).toBe(0);
  });
});

describe('scanObject', () => {
  it('records entry spans with and without trailing commas', () => {
    const text = '{"a": 1, "b": 2}';
    const span = scanObject(text, 0);
    expect(span.entries.map((e) => e.key)).toEqual(['a', 'b']);
    expect(span.braceEnd).toBe(15);
    expect(text.slice(span.entries[0]!.entryStart, span.entries[0]!.entryEnd)).toBe('"a": 1,');
    expect(text.slice(span.entries[1]!.valueStart, span.entries[1]!.valueEnd)).toBe('2');
  });

  it('treats comment text as plain characters, never as delimiters', () => {
    const text = `{
  // "a": 1, } [ ] { }
  "b": 2 /* } } */
}`;
    const span = scanObject(text, 0);
    expect(span.entries.map((e) => e.key)).toEqual(['b']);
  });

  it('keeps braces inside strings out of nesting math', () => {
    const span = scanObject('{"s": "a}b{c"}', 0);
    expect(span.entries).toHaveLength(1);
  });

  it('scans nested objects and arrays', () => {
    const span = scanObject('{"n": {"x": [1, {"y": 2}]}}', 0);
    expect(span.entries).toEqual([
      expect.objectContaining({ key: 'n' }),
    ]);
  });

  it('throws on unterminated objects and strings', () => {
    expect(() => scanObject('{"a": 1', 0)).toThrow('Unterminated object');
    expect(() => scanObject('{"a" 1}', 0)).toThrow('Expected colon');
    expect(() => scanObject('{"a": [1, 2', 0)).toThrow('Unterminated object/array');
    expect(() => scanObject('{a: 1}', 0)).toThrow('Expected object key');
  });

  it('throws on missing colon', () => {
    expect(() => scanObject('{"a"}', 0)).toThrow('Expected colon');
  });

  it('throws on unterminated strings', () => {
    expect(() => scanObject('{"a', 0)).toThrow('Unterminated string');
  });
});

describe('findTopLevelObject', () => {
  it('finds the root after leading comments', () => {
    const span = findTopLevelObject('// header\n{"a": 1}');
    expect(span?.entries.map((e) => e.key)).toEqual(['a']);
  });

  it('returns null for non-object roots', () => {
    expect(findTopLevelObject('[1]')).toBeNull();
    expect(findTopLevelObject('')).toBeNull();
  });
});

describe('stripJsonc / parseJsonc', () => {
  it('strips comments and trailing commas', () => {
    const parsed = parseJsonc(`{
      // c1
      "a": 1, /* c2 */ "b": [1, 2,],
    }`);
    expect(parsed).toEqual({ a: 1, b: [1, 2] });
  });

  it('preserves comment-like text inside strings', () => {
    expect(parseJsonc('{"s": "a//b/*c*/d,e"}')).toEqual({ s: 'a//b/*c*/d,e' });
  });

  it('keeps escaped quotes intact', () => {
    expect(parseJsonc('{"s": "a\\"b"}')).toEqual({ s: 'a"b' });
  });

  it('handles trailing commas before the closing brace/bracket', () => {
    expect(stripJsonc('{"a": 1, }')).toBe('{"a": 1 }');
    expect(stripJsonc('[1, 2,]')).toBe('[1, 2]');
  });
});

describe('insertObjectEntry', () => {
  it('inserts first entry into an empty object using close-brace indent', () => {
    const result = insertObjectEntry('{\n}', 0, 'mcp', '{"a": 1}');
    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toEqual({ mcp: { a: 1 } });
  });

  it('inserts before existing entries and re-indents the block', () => {
    const text = `{
  "z": 1
}`;
    const result = insertObjectEntry(text, 0, 'mcp', '{\n  "a": {"b": 2}\n}');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ mcp: { a: { b: 2 } }, z: 1 });
    expect(result.text).toContain('"mcp": {');
    expect(result.text).toContain('\n    "a": {"b": 2}');
  });

  it('is idempotent when the key already exists', () => {
    const text = '{"mcp": {"skillstate": {}}}';
    expect(insertObjectEntry(text, 0, 'mcp', '{}')).toEqual({ text, changed: false });
  });

  it('preserves comments around the splice point', () => {
    const text = `{
  // keep me
  "z": 1
}`;
    const result = insertObjectEntry(text, 0, 'mcp', '1');
    expect(result.text).toContain('// keep me');
    expect(parseJsonc(result.text)).toEqual({ mcp: 1, z: 1 });
  });
});

describe('removeObjectEntry', () => {
  it('removes a middle entry together with its trailing comma', () => {
    const text = '{"a": 1, "b": 2, "c": 3}';
    const result = removeObjectEntry(text, 0, 'b');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ a: 1, c: 3 });
  });

  it('removes the last entry together with the previous comma', () => {
    const text = '{"a": 1, "b": 2}';
    const result = removeObjectEntry(text, 0, 'b');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ a: 1 });
  });

  it('removes the first entry together with its trailing comma', () => {
    const text = '{"a": 1, "b": 2}';
    const result = removeObjectEntry(text, 0, 'a');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ b: 2 });
  });

  it('is idempotent for missing keys and keeps comments', () => {
    const text = `{
  // note
  "a": 1
}`;
    expect(removeObjectEntry(text, 0, 'nope')).toEqual({ text, changed: false });
    const result = removeObjectEntry(text, 0, 'a');
    expect(result.text).toContain('// note');
    expect(parseJsonc(result.text)).toEqual({});
  });
});

describe('scanArray', () => {
  it('records element spans with and without trailing commas', () => {
    const text = '["a", "b"]';
    const span = scanArray(text, 0);
    expect(span.elements).toHaveLength(2);
    expect(text.slice(span.elements[0]!.valueStart, span.elements[0]!.valueEnd)).toBe('"a"');
    expect(span.elements[0]!.elementEnd).toBe(span.elements[0]!.valueEnd + 1);
    expect(span.elements[1]!.elementEnd).toBe(span.elements[1]!.valueEnd);
    expect(span.bracketEnd).toBe(9);
  });

  it('scans nested structures and skips comments', () => {
    const text = `[
  // {"nested": "comment"}
  {"x": 1},
  [2, 3],
]`;
    const span = scanArray(text, 0);
    expect(span.elements).toHaveLength(2);
  });

  it('throws on an unterminated array', () => {
    expect(() => scanArray('["a", 1', 0)).toThrow('Unterminated array');
  });
});

describe('hasArrayStringEntry', () => {
  it('finds a plain string element and decodes escapes', () => {
    expect(hasArrayStringEntry('["a", "b"]', 0, 'b')).toBe(true);
    expect(hasArrayStringEntry('["a", "b"]', 0, 'c')).toBe(false);
    expect(hasArrayStringEntry('["a\\u0062"]', 0, 'ab')).toBe(true);
  });

  it('ignores non-string elements and unparseable string literals', () => {
    expect(hasArrayStringEntry('[1, true, {"x": "b"}]', 0, 'b')).toBe(false);
    expect(hasArrayStringEntry('["\\x"]', 0, 'x')).toBe(false);
  });
});

describe('insertArrayStringEntry', () => {
  it('inserts into an empty single-line array using the close-bracket indent', () => {
    const result = insertArrayStringEntry('{"plugin": []}', 11, '@skillstate/opencode');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ plugin: ['@skillstate/opencode'] });
  });

  it('appends after the last element and adds the separating comma', () => {
    const text = '{\n  "plugin": [\n    "one",\n    "two"\n  ]\n}';
    const start = text.indexOf('[');
    const result = insertArrayStringEntry(text, start, 'three');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ plugin: ['one', 'two', 'three'] });
    expect(result.text).toContain('"two",');
  });

  it('respects a trailing comma (no double comma) and preserves comments', () => {
    const text = '{\n  // plugins\n  "plugin": [\n    "one",\n  ],\n}';
    const start = text.indexOf('[');
    const result = insertArrayStringEntry(text, start, 'two');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ plugin: ['one', 'two'] });
    expect(result.text).toContain('// plugins');
    expect(result.text.includes(',\n    "two",,\n')).toBe(false);
  });

  it('is idempotent when the value already exists', () => {
    const text = '{"plugin": ["@skillstate/opencode"]}';
    expect(insertArrayStringEntry(text, text.indexOf('['), '@skillstate/opencode')).toEqual({
      text,
      changed: false,
    });
  });
});

describe('removeArrayStringEntry', () => {
  it('removes a middle element together with its trailing comma', () => {
    const text = '["a", "b", "c"]';
    const result = removeArrayStringEntry(text, 0, 'b');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual(['a', 'c']);
  });

  it('removes the last element together with the previous comma', () => {
    const text = '["a", "b"]';
    const result = removeArrayStringEntry(text, 0, 'b');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual(['a']);
  });

  it('removes a trailing-comma element cleanly and keeps comments', () => {
    const text = '{\n  // note\n  "plugin": [\n    "@skillstate/opencode",\n    "other",\n  ],\n}';
    const start = text.indexOf('[');
    const result = removeArrayStringEntry(text, start, '@skillstate/opencode');
    expect(result.changed).toBe(true);
    expect(parseJsonc(result.text)).toEqual({ plugin: ['other'] });
    expect(result.text).toContain('// note');
  });

  it('is idempotent for missing values', () => {
    const text = '["a"]';
    expect(removeArrayStringEntry(text, 0, 'nope')).toEqual({ text, changed: false });
    expect(removeArrayStringEntry('[1]', 0, '1')).toEqual({ text: '[1]', changed: false });
  });
});
