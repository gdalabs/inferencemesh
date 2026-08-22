import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { execFile } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../src/cli.js');

/**
 * The CLI, run as a program.
 *
 * `cli.ts` starts the CLI on import, so nothing here can be unit-tested — and
 * the bugs this file covers are all ones that only appear when the thing is
 * actually run. `route` touches no network and needs no key, so the whole file
 * works on a runner with no secrets.
 */
async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  // A key that is never used: it only has to be present, so the registry loads
  // a provider and the ranking has something in it.
  const env = { PATH: process.env['PATH'] ?? '', OPENROUTER_API_KEY: 'test-not-a-real-key' };
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env });
    return { code: 0, out: stdout, err: stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? 1, out: err.stdout ?? '', err: err.stderr ?? '' };
  }
}

describe('cli — a mistyped argument is a message, not a crash', () => {
  test('an unknown profile names the ones that exist', async () => {
    // This printed a stack trace with the Node version under it, while every
    // other bad input got one usable line.
    const r = await cli(['route', 'nosuchprofile']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown mesh profile 'nosuchprofile'/);
    assert.match(r.err, /free/, 'and lists what is available');
    assert.ok(!r.err.includes('at Registry.'), 'no stack trace');
  });

  test('an unknown privacy tier is refused, not passed through', async () => {
    // It used to reach the router and reject every candidate with
    // "privacy: needs internel", which reads as the registry being wrong.
    const r = await cli(['route', 'free', '--privacy=internel']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown privacy tier 'internel'/);
  });

  test('an unknown capability is refused, not passed through', async () => {
    const r = await cli(['route', 'free', '--capabilities=tols']);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown capability 'tols'/);
  });

  test('a non-numeric --min-context is caught rather than becoming NaN', async () => {
    // NaN filtered nothing at all, while looking exactly like a filter that
    // had been applied.
    const r = await cli(['route', 'free', '--min-context=abc']);
    assert.equal(r.code, 2);
    assert.match(r.err, /positive integer/);
  });

  test('an unknown command prints usage', async () => {
    const r = await cli(['nonsense']);
    assert.equal(r.code, 2);
    assert.match(r.err, /usage: inferencemesh/);
  });
});

describe('cli — the offline commands still work', () => {
  test('route ranks candidates and exits 0', async () => {
    const r = await cli(['route', 'free']);
    assert.equal(r.code, 0);
    assert.match(r.out, /profile: free/);
    assert.match(r.out, /score=/);
  });

  test('a valid --min-context is applied', async () => {
    const wide = await cli(['route', 'free', '--min-context=999999999']);
    assert.match(wide.out, /context: /, 'candidates are rejected for context, with a reason');
  });

  test('the whole output survives a pipe', async () => {
    // process.exit() truncates piped stdout; the CLI sets process.exitCode
    // instead. execFile reads through a pipe, so a regression shows up here.
    const r = await cli(['route', 'free']);
    assert.match(r.out.trimEnd(), /\$[\d.]+\/MTok\s+\w+$/, 'the last line is complete');
  });
});
