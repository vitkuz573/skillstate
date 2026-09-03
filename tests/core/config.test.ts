import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  defaultConfig,
  loadConfig,
  mergeConfig,
  CONFIG_FILE_NAME,
} from '../../src/core/config.js';

const ENV_KEYS = [
  'SKILLSTATE_SPEC_PATH',
  'SKILLSTATE_STATE_PATH',
  'SKILLSTATE_REPORT_PATH',
  'SKILLSTATE_MAX_STEPS',
  'SKILLSTATE_MAX_VALIDATION_RETRIES',
  'SKILLSTATE_TIMEOUT_MS',
  'SKILLSTATE_MAX_CHARS',
  'SKILLSTATE_PLATFORM',
  'SKILLSTATE_SESSION_NAME',
] as const;

let savedEnv: Record<string, string | undefined>;
let tmpDirs: string[] = [];

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-config-'));
  tmpDirs.push(dir);
  return dir;
}

function writeConfig(dir: string, value: unknown): void {
  fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), JSON.stringify(value), 'utf-8');
}

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  tmpDirs = [];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('defaultConfig', () => {
  it('returns the documented defaults', () => {
    expect(defaultConfig()).toEqual({
      specPath: './skill-spec.json',
      statePath: './.skillstate.json',
      reportPath: './skillstate-report.json',
      maxSteps: 100,
      maxValidationRetries: 2,
      platform: 'generic',
      sessionName: 'skillstate',
    });
  });
});

describe('loadConfig — file layer', () => {
  it('returns defaults when no file exists', () => {
    expect(loadConfig(makeTmp())).toEqual(defaultConfig());
  });

  it('reads a full valid file', () => {
    const dir = makeTmp();
    writeConfig(dir, {
      specPath: './s.json',
      statePath: './st.json',
      reportPath: './r.json',
      maxSteps: 7,
      maxValidationRetries: 1,
      timeoutMs: 500,
      maxChars: 9000,
      platform: 'claude',
      sessionName: 'file-session',
    });
    expect(loadConfig(dir)).toEqual({
      specPath: './s.json',
      statePath: './st.json',
      reportPath: './r.json',
      maxSteps: 7,
      maxValidationRetries: 1,
      timeoutMs: 500,
      maxChars: 9000,
      platform: 'claude',
      sessionName: 'file-session',
    });
  });

  it('falls back to defaults on corrupt JSON', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, CONFIG_FILE_NAME), '{oops', 'utf-8');
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('falls back to defaults when the file holds a non-record', () => {
    const dir = makeTmp();
    writeConfig(dir, [1, 2, 3]);
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('supports the legacy tokenBudgetChars alias', () => {
    const dir = makeTmp();
    writeConfig(dir, { tokenBudgetChars: 1234 });
    expect(loadConfig(dir).maxChars).toBe(1234);
  });

  it('ignores invalid file values (empty strings, negatives, bad platform)', () => {
    const dir = makeTmp();
    writeConfig(dir, {
      specPath: '',
      statePath: 42,
      reportPath: null,
      maxSteps: -3,
      maxValidationRetries: 1.5,
      timeoutMs: 'nope',
      maxChars: -1,
      platform: 'slack',
      sessionName: '',
    });
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('accepts numeric strings for int fields', () => {
    const dir = makeTmp();
    writeConfig(dir, { maxSteps: '5', maxValidationRetries: '0', timeoutMs: '250' });
    const cfg = loadConfig(dir);
    expect(cfg.maxSteps).toBe(5);
    expect(cfg.maxValidationRetries).toBe(0);
    expect(cfg.timeoutMs).toBe(250);
  });

  it('accepts zero and opencode platform from file', () => {
    const dir = makeTmp();
    writeConfig(dir, { maxSteps: 0, platform: 'opencode' });
    const cfg = loadConfig(dir);
    expect(cfg.maxSteps).toBe(0);
    expect(cfg.platform).toBe('opencode');
  });
});

describe('loadConfig — env overrides (env wins)', () => {
  it('env overrides every file value', () => {
    const dir = makeTmp();
    writeConfig(dir, {
      specPath: './file.json',
      statePath: './file-state.json',
      reportPath: './file-report.json',
      maxSteps: 7,
      maxValidationRetries: 1,
      timeoutMs: 500,
      maxChars: 100,
      platform: 'claude',
      sessionName: 'file',
    });
    process.env['SKILLSTATE_SPEC_PATH'] = './env-spec.json';
    process.env['SKILLSTATE_STATE_PATH'] = './env-state.json';
    process.env['SKILLSTATE_REPORT_PATH'] = './env-report.json';
    process.env['SKILLSTATE_MAX_STEPS'] = '11';
    process.env['SKILLSTATE_MAX_VALIDATION_RETRIES'] = '0';
    process.env['SKILLSTATE_TIMEOUT_MS'] = '777';
    process.env['SKILLSTATE_MAX_CHARS'] = '888';
    process.env['SKILLSTATE_PLATFORM'] = 'opencode';
    process.env['SKILLSTATE_SESSION_NAME'] = 'env-session';
    expect(loadConfig(dir)).toEqual({
      specPath: './env-spec.json',
      statePath: './env-state.json',
      reportPath: './env-report.json',
      maxSteps: 11,
      maxValidationRetries: 0,
      timeoutMs: 777,
      maxChars: 888,
      platform: 'opencode',
      sessionName: 'env-session',
    });
  });

  it('invalid env values are ignored (file wins)', () => {
    const dir = makeTmp();
    writeConfig(dir, { maxSteps: 9, platform: 'claude', sessionName: 'keep' });
    process.env['SKILLSTATE_MAX_STEPS'] = 'bogus';
    process.env['SKILLSTATE_PLATFORM'] = 'slack';
    process.env['SKILLSTATE_SESSION_NAME'] = '';
    process.env['SKILLSTATE_TIMEOUT_MS'] = '-5';
    process.env['SKILLSTATE_MAX_CHARS'] = '';
    const cfg = loadConfig(dir);
    expect(cfg.maxSteps).toBe(9);
    expect(cfg.platform).toBe('claude');
    expect(cfg.sessionName).toBe('keep');
    expect(cfg.timeoutMs).toBeUndefined();
    expect(cfg.maxChars).toBeUndefined();
  });
});

describe('mergeConfig', () => {
  it('treats non-record input as empty', () => {
    expect(mergeConfig(null)).toEqual(defaultConfig());
    expect(mergeConfig([1])).toEqual(defaultConfig());
    expect(mergeConfig('x')).toEqual(defaultConfig());
  });
});
