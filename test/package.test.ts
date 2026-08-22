import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Everything package.json promises has to exist after a build.
 *
 * `bin`, `exports` and `types` all pointed one directory too high — `dist/cli.js`
 * where the build writes `dist/src/cli.js` — because tsconfig includes the tests
 * and so emits under `dist/src`. Nothing failed locally: the Dockerfile names
 * the real path, the docs run the real path, and the only thing that would have
 * noticed was somebody installing the package, at which point `npx inferencemesh`
 * and `import 'inferencemesh'` would both resolve to files that do not exist.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

async function pkg(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8')) as Record<string, unknown>;
}

async function exists(rel: string): Promise<boolean> {
  try {
    await access(resolve(ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

describe('the published package points at files that exist', () => {
  test('every bin target is there', async () => {
    const bin = ((await pkg())['bin'] ?? {}) as Record<string, string>;
    assert.ok(Object.keys(bin).length > 0, 'there is a CLI to install');
    for (const [name, path] of Object.entries(bin)) {
      assert.ok(await exists(path), `bin '${name}' points at ${path}, which is not built`);
    }
  });

  test('every export target is there', async () => {
    const exports = ((await pkg())['exports'] ?? {}) as Record<string, string>;
    for (const [name, path] of Object.entries(exports)) {
      assert.ok(await exists(path), `export '${name}' points at ${path}, which is not built`);
    }
  });

  test('the type declarations are there', async () => {
    const types = (await pkg())['types'] as string;
    assert.ok(await exists(types), `types points at ${types}, which is not built`);
  });

  test('the files list ships the registry the code falls back to', async () => {
    // The embedded registry is a JSON import, so the build emits its own copy
    // next to the code. Shipping the source file without that copy leaves an
    // installed package whose fallback resolves to nothing.
    const files = ((await pkg())['files'] ?? []) as string[];
    for (const f of files) {
      assert.ok(await exists(f), `files lists ${f}, which does not exist`);
    }
    assert.ok(
      files.some((f) => f === 'dist' || f.startsWith('dist/providers')),
      'the built registry copy has to be inside the tarball',
    );
  });

  test('nothing in scripts runs a path the build does not produce', async () => {
    const scripts = ((await pkg())['scripts'] ?? {}) as Record<string, string>;
    const misses: string[] = [];
    for (const [name, cmd] of Object.entries(scripts)) {
      for (const m of cmd.matchAll(/\bdist\/[\w./-]+\.js\b/g)) {
        if (!(await exists(m[0]))) misses.push(`${name}: ${m[0]}`);
      }
    }
    assert.deepEqual(misses, [], misses.join('; '));
  });
});
