import { describe, it, expect } from 'vitest';
import {
  skipWsAndComments,
  scanObject,
  findTopLevelObject,
  stripJsonc,
  parseJsonc,
  insertObjectEntry,
  removeObjectEntry,
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
