// @non-paper JSONC surgery for host-config edits (additive).
//
// OpenCode's `opencode.jsonc` may carry comments and trailing commas, and
// rewriting the whole document would destroy them. This module scans JSONC
// text string-aware (quotes, escapes, line and block comments), locates
// object entries by span, and splices single keys in/out so everything
// around the edit point is preserved byte-for-byte.
//
// Zero dependencies, Node >= 20, ESM.

/** One `"key": <value>` entry inside a scanned object. */
export interface JsoncEntry {
  key: string;
  /** Index of the opening quote of the key. */
  entryStart: number;
  /** Index just past the value's trailing comma (when present). */
  entryEnd: number;
  /** Index of the first char of the value. */
  valueStart: number;
  /** Index just past the value's last char. */
  valueEnd: number;
}

/** Span of a `{ ... }` object in JSONC text. */
export interface JsoncObjectSpan {
  braceStart: number;
  braceEnd: number;
  entries: JsoncEntry[];
}

/** One element inside a scanned `[ ... ]` array. */
export interface JsoncArrayElement {
  /** Index of the first char of the element value. */
  valueStart: number;
  /** Index just past the element's last char. */
  valueEnd: number;
  /** Index just past the element's trailing comma (when present). */
  elementEnd: number;
}

/** Span of a `[ ... ]` array in JSONC text. */
export interface JsoncArraySpan {
  bracketStart: number;
  bracketEnd: number;
  elements: JsoncArrayElement[];
}

/** Result of an in-place entry insertion/removal. */
export interface JsoncEditResult {
  text: string;
  changed: boolean;
}

function isWs(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Skip whitespace and line/block comments starting at `i`. */
export function skipWsAndComments(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i] as string;
    if (isWs(ch)) {
      i += 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(i + 2, text.length);
    } else {
      break;
    }
  }
  return i;
}

/** Scan a `"string"` literal starting at `i` (must be `"`); returns the index past the closing quote. */
function scanString(text: string, i: number): number {
  i += 1;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '\\') {
      i += 2;
    } else if (ch === '"') {
      return i + 1;
    } else {
      i += 1;
    }
  }
  throw new Error('Unterminated string in JSONC');
}

/** Index just past the JSON value starting at `i` (object, array, string, or primitive). */
function scanValueEnd(text: string, i: number): number {
  const ch = text[i] as string | undefined;
  if (ch === '{' || ch === '[') {
    let depth = 0;
    while (i < text.length) {
      const c = text[i] as string;
      if (c === '"') {
        i = scanString(text, i);
      } else if (c === '{' || c === '[') {
        depth += 1;
        i += 1;
      } else if (c === '}' || c === ']') {
        depth -= 1;
        i += 1;
        if (depth === 0) {
          return i;
        }
      } else {
        i += 1;
      }
    }
    throw new Error('Unterminated object/array in JSONC');
  }
  if (ch === '"') {
    return scanString(text, i);
  }
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ',' || c === '}' || c === ']' || isWs(c)) {
      return i;
    }
    i += 1;
  }
  return i;
}

/** Scan the object whose `{` sits at `objStart` into a span with entry positions. */
export function scanObject(text: string, objStart: number): JsoncObjectSpan {
  let i = skipWsAndComments(text, objStart + 1);
  const entries: JsoncEntry[] = [];
  while (i < text.length) {
    if (text[i] === '}') {
      return { braceStart: objStart, braceEnd: i, entries };
    }
    if (text[i] !== '"') {
      throw new Error('Expected object key in JSONC');
    }
    const entryStart = i;
    const keyEnd = scanString(text, i);
    const key = JSON.parse(text.slice(entryStart, keyEnd)) as string;
    i = skipWsAndComments(text, keyEnd);
    if (text[i] !== ':') {
      throw new Error('Expected colon after key in JSONC');
    }
    i = skipWsAndComments(text, i + 1);
    const valueStart = i;
    const valueEnd = scanValueEnd(text, i);
    i = skipWsAndComments(text, valueEnd);
    let entryEnd = valueEnd;
    if (text[i] === ',') {
      entryEnd = i + 1;
      i = skipWsAndComments(text, i + 1);
    }
    entries.push({ key, entryStart, entryEnd, valueStart, valueEnd });
  }
  throw new Error('Unterminated object in JSONC');
}

/** Span of the document's root object, or null when the root is not an object. */
export function findTopLevelObject(text: string): JsoncObjectSpan | null {
  const i = skipWsAndComments(text, 0);
  if (i >= text.length || text[i] !== '{') {
    return null;
  }
  return scanObject(text, i);
}

/**
 * Scan the `[ ... ]` array whose `[` sits at `bracketStart` into a span with
 * element positions (same string/comment-aware scanning as
 * {@link scanObject}; trailing commas are absorbed into `elementEnd`).
 */
export function scanArray(text: string, bracketStart: number): JsoncArraySpan {
  let i = skipWsAndComments(text, bracketStart + 1);
  const elements: JsoncArrayElement[] = [];
  while (i < text.length) {
    if (text[i] === ']') {
      return { bracketStart, bracketEnd: i, elements };
    }
    const valueStart = i;
    const valueEnd = scanValueEnd(text, i);
    i = skipWsAndComments(text, valueEnd);
    let elementEnd = valueEnd;
    if (text[i] === ',') {
      elementEnd = i + 1;
      i = skipWsAndComments(text, i + 1);
    }
    elements.push({ valueStart, valueEnd, elementEnd });
  }
  throw new Error('Unterminated array in JSONC');
}

/** Decoded string value of an array element, or null when it is not a (parseable) string. */
function arrayElementString(text: string, el: JsoncArrayElement): string | null {
  if (text[el.valueStart] !== '"') {
    return null;
  }
  const raw = text.slice(el.valueStart, el.valueEnd);
  try {
    return JSON.parse(raw) as string;
  } catch {
    return null;
  }
}

/** Strip line/block comments and trailing commas so `JSON.parse` can read the rest. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === '"') {
      const end = scanString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && text[i + 1] === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') {
        i += 1;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) {
        i += 1;
      }
      i = Math.min(i + 2, text.length);
    } else if (ch === ',') {
      const next = skipWsAndComments(text, i + 1);
      if (next >= text.length || text[next] === '}' || text[next] === ']') {
        i += 1;
      } else {
        out += ch;
        i += 1;
      }
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Parse JSONC text (comments + trailing commas tolerated) via JSON.parse. */
export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}

/** Leading whitespace of the line containing `index`. */
function lineIndentAt(text: string, index: number): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  let indent = '';
  let j = lineStart;
  while (j < text.length && (text[j] === ' ' || text[j] === '\t')) {
    indent += text[j];
    j += 1;
  }
  return indent;
}

/** Indent for entries inside `span`: the first entry's indent, or the closing brace's indent + two spaces. */
function entryIndent(text: string, span: JsoncObjectSpan): string {
  if (span.entries.length > 0) {
    return lineIndentAt(text, span.entries[0]!.entryStart);
  }
  return `${lineIndentAt(text, span.braceEnd)}  `;
}

/** Re-indent a pretty-printed JSON block so its first line stays in place. */
function reindent(json: string, indent: string): string {
  const lines = json.split('\n');
  return [lines[0] as string, ...lines.slice(1).map((l) => indent + l)].join('\n');
}

/**
 * Splice one `"key": <valueJson>` entry into the object at `objStart`,
 * preserving all surrounding text (comments included). Idempotent: when the
 * key already exists the text is returned unchanged.
 */
export function insertObjectEntry(
  text: string,
  objStart: number,
  key: string,
  valueJson: string,
): JsoncEditResult {
  const span = scanObject(text, objStart);
  if (span.entries.some((e) => e.key === key)) {
    return { text, changed: false };
  }
  const indent = entryIndent(text, span);
  const body = reindent(`"${key}": ${valueJson}`, indent);
  if (span.entries.length === 0) {
    const closeIndent = lineIndentAt(text, span.braceEnd);
    const inserted = `\n${indent}${body}\n${closeIndent}`;
    return {
      text: text.slice(0, span.braceStart + 1) + inserted + text.slice(span.braceEnd),
      changed: true,
    };
  }
  const inserted = `\n${indent}${body},`;
  return {
    text: text.slice(0, span.braceStart + 1) + inserted + text.slice(span.braceStart + 1),
    changed: true,
  };
}

/**
 * Splice the `"key"` entry out of the object at `objStart`, keeping the rest
 * valid (the entry's trailing comma, or the previous entry's comma for a last
 * entry, goes with it). Idempotent: a missing key returns the text unchanged.
 */
export function removeObjectEntry(
  text: string,
  objStart: number,
  key: string,
): JsoncEditResult {
  const span = scanObject(text, objStart);
  const entry = span.entries.find((e) => e.key === key);
  if (entry === undefined) {
    return { text, changed: false };
  }
  let start = entry.entryStart;
  let end = entry.entryEnd;
  if (end === entry.valueEnd) {
    let j = start - 1;
    while (j >= 0 && isWs(text[j] as string)) {
      j -= 1;
    }
    if (j >= 0 && text[j] === ',') {
      start = j;
    }
  }
  return {
    text: text.slice(0, start) + text.slice(end),
    changed: true,
  };
}

/** Indent for elements inside `span`: the first element's indent, or the closing bracket's indent + two spaces. */
function arrayElementIndent(text: string, span: JsoncArraySpan): string {
  if (span.elements.length > 0) {
    return lineIndentAt(text, span.elements[0]!.valueStart);
  }
  return `${lineIndentAt(text, span.bracketEnd)}  `;
}

/**
 * True when the array whose `[` sits at `arrayStart` holds a plain-string
 * element equal to `value` (string-aware: comments and nesting inside other
 * elements are skipped, escapes are decoded before comparing).
 */
export function hasArrayStringEntry(text: string, arrayStart: number, value: string): boolean {
  return scanArray(text, arrayStart).elements.some(
    (el) => arrayElementString(text, el) === value,
  );
}

/**
 * Splice one `"value"` string element into the array at `arrayStart`,
 * preserving all surrounding text (comments included). Appends after the
 * last element (comma-managed, trailing commas respected); an empty array
 * gets its first element at the surrounding indentation. Idempotent: when
 * the value is already present the text is returned unchanged.
 */
export function insertArrayStringEntry(
  text: string,
  arrayStart: number,
  value: string,
): JsoncEditResult {
  if (hasArrayStringEntry(text, arrayStart, value)) {
    return { text, changed: false };
  }
  const span = scanArray(text, arrayStart);
  const literal = JSON.stringify(value);
  const indent = arrayElementIndent(text, span);
  if (span.elements.length === 0) {
    const closeIndent = lineIndentAt(text, span.bracketEnd);
    return {
      text:
        text.slice(0, span.bracketStart + 1) +
        `\n${indent}${literal}\n${closeIndent}` +
        text.slice(span.bracketEnd),
      changed: true,
    };
  }
  const last = span.elements[span.elements.length - 1]!;
  const at = last.elementEnd;
  // A trailing comma before `]` already separates; otherwise add one.
  const chunk = text[at - 1] === ',' ? `\n${indent}${literal}` : `,\n${indent}${literal}`;
  return { text: text.slice(0, at) + chunk + text.slice(at), changed: true };
}

/**
 * Splice the `"value"` string element out of the array at `arrayStart`,
 * keeping the rest valid (the element's trailing comma, or the previous
 * element's comma for a last element, goes with it). Idempotent: a missing
 * value returns the text unchanged.
 */
export function removeArrayStringEntry(
  text: string,
  arrayStart: number,
  value: string,
): JsoncEditResult {
  const span = scanArray(text, arrayStart);
  const el = span.elements.find((e) => arrayElementString(text, e) === value);
  if (el === undefined) {
    return { text, changed: false };
  }
  let start = el.valueStart;
  let end = el.elementEnd;
  if (end === el.valueEnd) {
    let j = start - 1;
    while (j >= 0 && isWs(text[j] as string)) {
      j -= 1;
    }
    if (j >= 0 && text[j] === ',') {
      start = j;
    }
  }
  return {
    text: text.slice(0, start) + text.slice(end),
    changed: true,
  };
}
