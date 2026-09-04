import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  main,
  parseRunArgs,
  parseReportArgs,
  loadCliConfig,
  loadCliSpec,
  loadResumeState,
  resolveInCwd,
  stubLlmResponse,
  wantsHelp,
  HelpRequestedError,
  CLI_USAGE,
} from '@skillstate/cli';
import { CONFIG_FILE_NAME } from '@skillstate/core';
import { GENERIC_PROCEDURE_SPEC, INTERCODE_CTF_SPEC } from '@skillstate/core/schemas';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO_ROOT, 'packages', 'cli', 'bin', 'skillstate.js');

let tmpDirs: string[] = [];
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function makeTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skillstate-cli-'));
  tmpDirs.push(dir);
  return dir;
}

function writeJson(absPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, JSON.stringify(value), 'utf-8');
}

beforeAll(() => {
  if (fs.existsSync(path.join(REPO_ROOT, 'packages', 'cli', 'dist', 'index.js')) === false) {
    execFileSync(process.execPath, [path.join(REPO_ROOT, 'node_modules', '.bin', 'tsc'), '-b'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
    });
  }
});

beforeEach(() => {
  tmpDirs = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveInCwd', () => {
  it('passes absolute paths through', () => {
    expect(resolveInCwd('/a/b', '/x/y.json')).toBe('/x/y.json');
  });

  it('joins relative paths onto cwd', () => {
    expect(resolveInCwd('/a/b', 'c.json')).toBe(path.join('/a/b', 'c.json'));
  });
});

describe('stubLlmResponse', () => {
  it('returns a parseable two-key response', () => {
    expect(stubLlmResponse()).toContain('state_patch');
  });
});

describe('parseRunArgs', () => {
  it('defaults to no config and no resume', () => {
    expect(parseRunArgs([])).toEqual({ configPath: undefined, resume: false });
  });

  it('parses --resume', () => {
    expect(parseRunArgs(['--resume'])).toEqual({ configPath: undefined, resume: true });
  });

  it('parses --config <path>', () => {
    expect(parseRunArgs(['--config', 'custom.json'])).toEqual({
      configPath: 'custom.json',
      resume: false,
    });
  });

  it('parses --config=<path> and combines with --resume', () => {
    expect(parseRunArgs(['--config=custom.json', '--resume'])).toEqual({
      configPath: 'custom.json',
      resume: true,
    });
  });

  it('throws usage on missing --config value (end of args)', () => {
    expect(() => parseRunArgs(['--config'])).toThrow(CLI_USAGE);
  });

  it('throws usage when --config is followed by another flag', () => {
    expect(() => parseRunArgs(['--config', '--resume'])).toThrow(CLI_USAGE);
  });

  it('throws usage on empty --config= value', () => {
    expect(() => parseRunArgs(['--config='])).toThrow(CLI_USAGE);
  });

  it('throws usage on unknown flags', () => {
    expect(() => parseRunArgs(['--bogus'])).toThrow(CLI_USAGE);
  });
});

describe('parseReportArgs', () => {
  it('defaults to json', () => {
    expect(parseReportArgs([])).toEqual({ format: 'json' });
  });

  it('parses --format md', () => {
    expect(parseReportArgs(['--format', 'md'])).toEqual({ format: 'md' });
  });

  it('parses --format=json', () => {
    expect(parseReportArgs(['--format=json'])).toEqual({ format: 'json' });
  });

  it('parses --format=md', () => {
    expect(parseReportArgs(['--format=md'])).toEqual({ format: 'md' });
  });

  it('throws usage on invalid --format value', () => {
    expect(() => parseReportArgs(['--format', 'xml'])).toThrow(CLI_USAGE);
  });

  it('throws usage on missing --format value', () => {
    expect(() => parseReportArgs(['--format'])).toThrow(CLI_USAGE);
  });

  it('throws usage on invalid --format= value', () => {
    expect(() => parseReportArgs(['--format=xml'])).toThrow(CLI_USAGE);
  });

  it('throws usage on unknown flags', () => {
    expect(() => parseReportArgs(['--bogus'])).toThrow(CLI_USAGE);
  });
});

describe('loadCliConfig', () => {
  it('delegates to loadConfig without an override', () => {
    const dir = makeTmp();
    const cfg = loadCliConfig(dir);
    expect(cfg.maxSteps).toBe(100);
  });

  it('reads an explicit config file', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 'custom.json'), { maxSteps: 4 });
    expect(loadCliConfig(dir, 'custom.json').maxSteps).toBe(4);
  });

  it('resolves to defaults when the override file is missing', () => {
    const dir = makeTmp();
    expect(loadCliConfig(dir, 'nope.json').maxSteps).toBe(100);
  });

  it('resolves to defaults when the override file is corrupt', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops', 'utf-8');
    expect(loadCliConfig(dir, 'bad.json').maxSteps).toBe(100);
  });
});

describe('loadCliSpec', () => {
  it('returns the builtin for @intercode-ctf', () => {
    expect(loadCliSpec(makeTmp(), '@intercode-ctf')).toBe(INTERCODE_CTF_SPEC);
  });

  it('loads a valid spec file', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), INTERCODE_CTF_SPEC);
    expect(loadCliSpec(dir, 's.json')).toEqual(INTERCODE_CTF_SPEC);
  });

  it('falls back to builtin when the file is missing', () => {
    expect(loadCliSpec(makeTmp(), 'missing.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin on corrupt JSON', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops', 'utf-8');
    expect(loadCliSpec(dir, 'bad.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when id is not a string', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), { ...INTERCODE_CTF_SPEC, id: 42 });
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when name is not a string', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), { ...INTERCODE_CTF_SPEC, name: 42 });
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when instructions are not a string', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), { ...INTERCODE_CTF_SPEC, instructions: 42 });
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when schema is not a record', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), { ...INTERCODE_CTF_SPEC, schema: [] });
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when version is not a string', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), { ...INTERCODE_CTF_SPEC, version: 2 });
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });

  it('falls back to builtin when the file holds a primitive', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 's.json'), 42);
    expect(loadCliSpec(dir, 's.json')).toBe(GENERIC_PROCEDURE_SPEC);
  });
});

describe('loadResumeState', () => {
  it('returns null when no state file exists', () => {
    expect(loadResumeState(makeTmp(), './.skillstate.json')).toBeNull();
  });

  it('returns null on corrupt state', () => {
    const dir = makeTmp();
    fs.writeFileSync(path.join(dir, '.skillstate.json'), '{oops', 'utf-8');
    expect(loadResumeState(dir, './.skillstate.json')).toBeNull();
  });

  it('returns null on unmigratable garbage', () => {
    const dir = makeTmp();
    writeJson(path.join(dir, '.skillstate.json'), [1, 2]);
    expect(loadResumeState(dir, './.skillstate.json')).toBeNull();
  });

  it('loads a committed envelope', async () => {
    const dir = makeTmp();
    await main(['init'], dir);
    await main(['run', '--config', CONFIG_FILE_NAME], dir);
    const state = loadResumeState(dir, './.skillstate.json');
    expect(state).not.toBeNull();
  });
});

describe('main init', () => {
  it('creates config + spec from a clean directory', async () => {
    const dir = makeTmp();
    const code = await main(['init'], dir);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, CONFIG_FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(true);
  });

  it('reports existing files without overwriting', async () => {
    const dir = makeTmp();
    await main(['init'], dir);
    const before = fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), 'utf-8');
    const specBefore = fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8');
    const code = await main(['init'], dir);
    expect(code).toBe(0);
    expect(fs.readFileSync(path.join(dir, CONFIG_FILE_NAME), 'utf-8')).toBe(before);
    expect(fs.readFileSync(path.join(dir, 'skill-spec.json'), 'utf-8')).toBe(specBefore);
    expect(logSpy.mock.calls.join('\n')).toContain('skill-spec.json already exists');
  });

  it('creates a missing spec when config already exists', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, CONFIG_FILE_NAME), { maxSteps: 5 });
    const code = await main(['init'], dir);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'skill-spec.json'))).toBe(true);
  });

  it('creates a missing config when spec already exists', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 'skill-spec.json'), INTERCODE_CTF_SPEC);
    const code = await main(['init'], dir);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, CONFIG_FILE_NAME))).toBe(true);
  });

  it('rejects init flags with usage (exit 2)', async () => {
    const code = await main(['init', '--bogus'], makeTmp());
    expect(code).toBe(2);
  });
});

describe('main run', () => {
  function tinyConfig(dir: string, extra: Record<string, unknown> = {}): void {
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      maxSteps: 2,
      statePath: './state.json',
      reportPath: './report.json',
      ...extra,
    });
  }

  it('runs offline and writes state + report', async () => {
    const dir = makeTmp();
    tinyConfig(dir);
    const code = await main(['run'], dir);
    expect(code).toBe(0);
    expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'report.json'))).toBe(true);
  });

  it('honors --config and --resume across runs', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, 'custom.json'), {
      maxSteps: 1,
      statePath: './c-state.json',
      reportPath: './c-report.json',
    });
    expect(await main(['run', '--config', 'custom.json'], dir)).toBe(0);
    expect(await main(['run', '--config=custom.json', '--resume'], dir)).toBe(0);
  });

  it('passes timeoutMs through when configured', async () => {
    const dir = makeTmp();
    tinyConfig(dir, { timeoutMs: 5000 });
    expect(await main(['run'], dir)).toBe(0);
  });

  it('maps invalid run flags to exit 2', async () => {
    expect(await main(['run', '--bogus'], makeTmp())).toBe(2);
  });

  it('maps missing --config value to exit 2', async () => {
    expect(await main(['run', '--config'], makeTmp())).toBe(2);
  });
});

describe('main report', () => {
  async function runTiny(dir: string): Promise<void> {
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      maxSteps: 2,
      statePath: './state.json',
      reportPath: './report.json',
    });
    await main(['run'], dir);
  }

  it('prints json by default', async () => {
    const dir = makeTmp();
    await runTiny(dir);
    logSpy.mockClear();
    expect(await main(['report'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('metrics');
  });

  it('prints markdown with --format md', async () => {
    const dir = makeTmp();
    await runTiny(dir);
    logSpy.mockClear();
    expect(await main(['report', '--format', 'md'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('# SkillState Report');
  });

  it('prints markdown with --format=md', async () => {
    const dir = makeTmp();
    await runTiny(dir);
    logSpy.mockClear();
    expect(await main(['report', '--format=md'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('# SkillState Report');
  });

  it('errors when no report exists (exit 1)', async () => {
    const dir = makeTmp();
    expect(await main(['report'], dir)).toBe(1);
  });

  it('errors on a corrupt report (exit 1)', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      reportPath: './report.json',
      statePath: './state.json',
    });
    fs.writeFileSync(path.join(dir, 'report.json'), '{oops', 'utf-8');
    expect(await main(['report'], dir)).toBe(1);
    expect(await main(['report', '--format', 'md'], dir)).toBe(1);
  });

  it('errors on a non-record md report (exit 1)', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      reportPath: './report.json',
      statePath: './state.json',
    });
    fs.writeFileSync(path.join(dir, 'report.json'), '[1,2]', 'utf-8');
    expect(await main(['report', '--format', 'md'], dir)).toBe(1);
  });

  it('renders md with missing metrics/session/steps fallbacks', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      reportPath: './report.json',
      statePath: './state.json',
    });
    writeJson(path.join(dir, 'report.json'), { hello: 'world' });
    logSpy.mockClear();
    expect(await main(['report', '--format', 'md'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('# SkillState Report');
  });

  it('treats invalid promptChars as zero in md comparison', async () => {
    const dir = makeTmp();
    writeJson(path.join(dir, CONFIG_FILE_NAME), {
      reportPath: './report.json',
      statePath: './state.json',
    });
    writeJson(path.join(dir, 'report.json'), {
      metrics: { sessionName: 's', totalChars: 0, stepCount: 0, averagePromptSize: 0 },
      steps: [{ promptChars: -5 }, { promptChars: 'x' }, {}],
      session: { name: 's', platform: 'generic', startedAt: 'not-a-date' },
    });
    logSpy.mockClear();
    expect(await main(['report', '--format', 'md'], dir)).toBe(0);
  });

  it('maps invalid report flags to exit 2', async () => {
    expect(await main(['report', '--bogus'], makeTmp())).toBe(2);
  });
});

describe('wantsHelp', () => {
  it('detects --help and -h', () => {
    expect(wantsHelp(['--help'])).toBe(true);
    expect(wantsHelp(['-h'])).toBe(true);
    expect(wantsHelp(['run', '--help'])).toBe(true);
    expect(wantsHelp(['--bogus'])).toBe(false);
    expect(wantsHelp([])).toBe(false);
  });
});

describe('parseRunArgs/parseReportArgs help (FIX 2)', () => {
  it('parseRunArgs throws HelpRequestedError for --help/-h', () => {
    expect(() => parseRunArgs(['--help'])).toThrow(HelpRequestedError);
    expect(() => parseRunArgs(['-h'])).toThrow(HelpRequestedError);
  });

  it('parseReportArgs throws HelpRequestedError for --help/-h', () => {
    expect(() => parseReportArgs(['--help'])).toThrow(HelpRequestedError);
    expect(() => parseReportArgs(['-h'])).toThrow(HelpRequestedError);
  });
});

describe('main usage', () => {
  it('returns 2 for unknown commands', async () => {
    expect(await main(['frobnicate'], makeTmp())).toBe(2);
  });

  it('returns 2 with no command', async () => {
    expect(await main([], makeTmp())).toBe(2);
  });

  it('defaults cwd to process.cwd() when omitted', async () => {
    expect(await main(['frobnicate'])).toBe(2);
    expect(errorSpy.mock.calls.join('\n')).toContain('Usage:');
  });

  it('stringifies non-Error throws in the usage catch-all', async () => {
    const dir = makeTmp();
    logSpy.mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw 'string-boom';
    });
    expect(await main(['init'], dir)).toBe(2);
    expect(errorSpy.mock.calls.join('\n')).toContain('string-boom');
  });
});

describe('main --help (FIX 2)', () => {
  it('prints usage and exits 0 for a bare --help / -h', async () => {
    logSpy.mockClear();
    expect(await main(['--help'], makeTmp())).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');

    logSpy.mockClear();
    expect(await main(['-h'], makeTmp())).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');
  });

  it('prints usage and exits 0 for init --help / init -h', async () => {
    logSpy.mockClear();
    expect(await main(['init', '--help'], makeTmp())).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');

    logSpy.mockClear();
    expect(await main(['init', '-h'], makeTmp())).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');
  });

  it('prints usage and exits 0 for run --help / run -h without executing', async () => {
    const dir = makeTmp();
    logSpy.mockClear();
    expect(await main(['run', '--help'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');

    // Help must NOT run the benchmark/state machinery.
    expect(fs.existsSync(path.join(dir, '.skillstate.json'))).toBe(false);

    logSpy.mockClear();
    expect(await main(['run', '-h'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');
  });

  it('prints usage and exits 0 for report --help / report -h', async () => {
    const dir = makeTmp();
    logSpy.mockClear();
    expect(await main(['report', '--help'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');

    logSpy.mockClear();
    expect(await main(['report', '-h'], dir)).toBe(0);
    expect(logSpy.mock.calls.join('\n')).toContain('Usage:');
  });
});

describe('bin/skillstate.js — init+run+report from a clean directory', () => {
  it('drives the full offline flow through node bin', () => {
    const dir = makeTmp();
    const run = (args: string[], env: Record<string, string> = {}): string =>
      execFileSync(process.execPath, [BIN, ...args], {
        cwd: dir,
        encoding: 'utf-8',
        env: { ...process.env, ...env },
      });

    run(['init']);
    expect(fs.existsSync(path.join(dir, CONFIG_FILE_NAME))).toBe(true);

    run(['run'], { SKILLSTATE_MAX_STEPS: '3' });
    expect(fs.existsSync(path.join(dir, '.skillstate.json'))).toBe(true);

    const json = run(['report', '--format', 'json']);
    expect(json).toContain('metrics');

    const md = run(['report', '--format', 'md']);
    expect(md).toContain('# SkillState Report');
  }, 60000);
});
