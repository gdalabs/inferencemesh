import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The public entry point must stay runnable in a Cloudflare Worker.
 *
 * The README sells that, and it is the sort of claim that breaks silently: one
 * `import { randomUUID } from 'node:crypto'` somewhere in the router and every
 * Worker deploy starts failing at boot, while every test here still passes,
 * because the tests run on Node. Nothing else checks it.
 *
 * The walk follows relative imports from index.ts rather than scanning src/,
 * since `cli.ts`, `server/node.ts` and `setup.ts` are Node programs by design
 * and are deliberately not reachable from the entry point.
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../src');

async function reachableFromIndex(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const queue = ['index.ts'];
  while (queue.length) {
    const rel = queue.shift() as string;
    if (files.has(rel)) continue;
    const source = await readFile(resolve(SRC, rel), 'utf8');
    files.set(rel, source);
    for (const m of source.matchAll(/from\s+'(\.[^']+)'/g)) {
      const spec = (m[1] as string).replace(/\.js$/, '.ts');
      const next = resolve(dirname(resolve(SRC, rel)), spec);
      queue.push(next.slice(SRC.length + 1));
    }
  }
  return files;
}

describe('the public entry point stays runtime-agnostic', () => {
  test('nothing reachable from index.ts imports a Node built-in', async () => {
    const files = await reachableFromIndex();
    const offenders: string[] = [];
    for (const [file, source] of files) {
      for (const m of source.matchAll(/from\s+'(node:[^']+)'/g)) {
        offenders.push(`${file} imports ${m[1] as string}`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  test('nothing reachable from index.ts reaches for a Node global', async () => {
    // `process.env` is the one that gets added without thinking. A Worker has
    // no process, and the Registry already takes its environment as an option
    // precisely so nobody needs one.
    const files = await reachableFromIndex();
    const offenders: string[] = [];
    for (const [file, source] of files) {
      const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const global of ['process.env', '__dirname', 'require(']) {
        if (stripped.includes(global)) offenders.push(`${file} uses ${global}`);
      }
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });

  test('the walk actually reached the modules it claims to check', async () => {
    // A traversal that silently found nothing would pass both tests above
    // while checking one file. This is the fixture that proves the ruler.
    const files = await reachableFromIndex();
    for (const expected of ['index.ts', 'router.ts', 'mesh.ts', 'gateway.ts', 'providers/openai-compat.ts']) {
      assert.ok(files.has(expected), `${expected} was not reached`);
    }
    assert.ok(!files.has('server/node.ts'), 'the Node server is deliberately not reachable');
  });
});

describe('the settings are documented', () => {
  test('every environment variable the server reads appears in the README', async () => {
    // A setting nobody documented is a setting nobody can use, and the drift
    // is silent: the code keeps working, the README simply stops being true.
    // Eight of the ten were missing when this was written.
    const [server, readme] = await Promise.all([
      readFile(resolve(SRC, 'server/node.ts'), 'utf8'),
      readFile(resolve(SRC, '../README.md'), 'utf8'),
    ]);
    const used = new Set([...server.matchAll(/INFERENCEMESH_[A-Z_]+/g)].map((m) => m[0]));
    const missing = [...used].filter((v) => !readme.includes(v)).sort();
    assert.deepEqual(missing, [], `undocumented: ${missing.join(', ')}`);
  });

  test('the README does not document settings that no longer exist', async () => {
    const [server, setup, readme] = await Promise.all([
      readFile(resolve(SRC, 'server/node.ts'), 'utf8'),
      readFile(resolve(SRC, 'setup.ts'), 'utf8'),
      readFile(resolve(SRC, '../README.md'), 'utf8'),
    ]);
    const real = new Set([...`${server}${setup}`.matchAll(/INFERENCEMESH_[A-Z_]+/g)].map((m) => m[0]));
    const documented = new Set([...readme.matchAll(/INFERENCEMESH_[A-Z_]+/g)].map((m) => m[0]));
    const stale = [...documented].filter((v) => !real.has(v)).sort();
    assert.deepEqual(stale, [], `documented but unread: ${stale.join(', ')}`);
  });
});

describe('the Worker example', () => {
  test('the README shows the file the build compiles', async () => {
    // The version that lived only in the README did not type-check: handing a
    // Worker `Env` straight to registryFrom fails on a missing index
    // signature, which is the reader's first compile. The example is a real
    // file now, and this keeps the two from drifting apart again.
    const [src, readme] = await Promise.all([
      readFile(resolve(SRC, '../examples/worker.ts'), 'utf8'),
      readFile(resolve(SRC, '../README.md'), 'utf8'),
    ]);
    const body = (src.split('*/\n')[1] ?? '')
      .trimStart()
      .replace("'../src/index.js'", "'inferencemesh'")
      .replace("'../providers.default.json'", "'./providers.json'")
      .trimEnd();
    assert.ok(body.length > 0, 'the example has a body to compare');
    assert.ok(
      readme.includes(body),
      'README and examples/worker.ts have drifted — the README block is not the compiled file',
    );
  });
});

describe('the CLI flags are documented', () => {
  test('every flag the CLI reads appears in the README', async () => {
    // Same silent drift as the settings: --capabilities, --privacy and
    // --min-context existed, worked, and were written down nowhere.
    const [cli, readme] = await Promise.all([
      readFile(resolve(SRC, 'cli.ts'), 'utf8'),
      readFile(resolve(SRC, '../README.md'), 'utf8'),
    ]);
    const flags = new Set<string>();
    for (const m of cli.matchAll(/arg\('([a-z-]+)'\)/g)) flags.add(`--${m[1] as string}`);
    for (const m of cli.matchAll(/startsWith\('(--[a-z-]+)/g)) flags.add(m[1] as string);
    for (const m of cli.matchAll(/includes\('(--[a-z-]+)'\)/g)) flags.add(m[1] as string);
    const missing = [...flags].filter((f) => !readme.includes(f)).sort();
    assert.deepEqual(missing, [], `undocumented flags: ${missing.join(', ')}`);
  });
});
