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
