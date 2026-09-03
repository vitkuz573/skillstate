import { describe, it, expect } from 'vitest';
import { REDACTED, redactSecrets } from '../../src/core/redaction.js';

describe('redactSecrets', () => {
  it('leaves text without secrets untouched', () => {
    const text = 'hello world, no credentials here: Bearer of good news';
    expect(redactSecrets(text)).toBe(text);
  });

  it('handles empty input', () => {
    expect(redactSecrets('')).toBe('');
  });

  it('redacts AWS access keys (AKIA…)', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    expect(redactSecrets(`key=${key} end`)).toBe(`key=${REDACTED} end`);
    // A bare AKIA prefix without the 16-char suffix is not a key.
    expect(redactSecrets('AKIA is just a prefix')).toBe(
      'AKIA is just a prefix',
    );
  });

  it('redacts GitHub tokens (ghp_…)', () => {
    const token = 'ghp_abcDEF1234567890XYZ';
    const out = redactSecrets(`token ${token} done`);
    expect(out).toBe(`token ${REDACTED} done`);
    expect(out).not.toContain('ghp_');
  });

  it('redacts OpenAI-style keys (sk-…)', () => {
    const short = 'sk-abc123XYZ_-test';
    expect(redactSecrets(`api ${short}!`)).toBe(`api ${REDACTED}!`);
    const proj = 'sk-proj-abcDEF123456';
    expect(redactSecrets(proj)).toBe(REDACTED);
  });

  it('redacts Bearer tokens but keeps the scheme', () => {
    expect(redactSecrets('Authorization: Bearer abc.def-123_~+/=')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
    // A bare "Bearer" with no token is prose, not a credential.
    expect(redactSecrets('the Bearer of bad news')).toBe(
      'the Bearer of bad news',
    );
  });

  it('redacts PEM private-key blocks wholesale', () => {
    const pem = [
      '-----BEGIN RSA PRIVATE KEY-----',
      'MIIEpAIBAAKCAQEA7b8F2k',
      'c2VjcmV0LWRhdGE=',
      '-----END RSA PRIVATE KEY-----',
    ].join('\n');
    const out = redactSecrets(`prefix\n${pem}\nsuffix`);
    expect(out).toBe(`prefix\n${REDACTED}\nsuffix`);
    expect(out).not.toContain('MIIEpAIBAAKCAQEA7b8F2k');
    expect(out).not.toContain('PRIVATE KEY');
  });

  it('redacts a generic PRIVATE KEY block variant', () => {
    const pem =
      '-----BEGIN PRIVATE KEY-----\nABCD\n-----END PRIVATE KEY-----';
    expect(redactSecrets(pem)).toBe(REDACTED);
  });

  it('redacts several secrets in one pass, including repeats', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const text = `${key} then Bearer tok123abc then ${key} again`;
    const out = redactSecrets(text);
    expect(out).toBe(
      `${REDACTED} then Bearer [REDACTED] then ${REDACTED} again`,
    );
  });

  it('does not mutate the input string', () => {
    const text = 'sk-secret-value Bearer abc';
    const snapshot = text;
    redactSecrets(text);
    expect(text).toBe(snapshot);
  });
});
