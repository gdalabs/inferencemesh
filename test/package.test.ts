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

describe('nothing pulls package.json into the bundle', () => {
  test('no source file imports it', async () => {
    // A JSON import inlines the whole file. package.json holds the
    // `build:binary` script, which holds the SEA sentinel, so the sentinel
    // ends up inside the blob and postject refuses to inject: "Multiple
    // occurences of sentinel found in the binary". Every unit test passed and
    // the single executable could not be built. Measured, not theorised.
    const dir = resolve(ROOT, 'src');
    const files: string[] = [];
    const walk = async (d: string): Promise<void> => {
      const { readdir } = await import('node:fs/promises');
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = resolve(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.name.endsWith('.ts')) files.push(full);
      }
    };
    await walk(dir);
    const offenders: string[] = [];
    for (const f of files) {
      // Comments stripped first. The file that explains this rule quotes the
      // import it forbids, and the first version of this check failed on that
      // — a detector reading prose as code, which is its own bug class.
      const source = (await readFile(f, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/from\s+'[^']*package\.json'/.test(source)) offenders.push(f.slice(ROOT.length + 1));
    }
    assert.deepEqual(offenders, [], offenders.join('; '));
  });
});

describe('the version is stated once', () => {
  test('src/version.ts matches package.json', async () => {
    // The CLI cannot import package.json: a JSON import inlines the whole file
    // into the bundle, scripts included, and `build:binary` contains the SEA
    // sentinel — postject then finds it twice and refuses to inject. So the
    // version is written in two places, and this is what keeps them equal.
    const { VERSION } = await import('../src/version.js');
    assert.equal(VERSION, (await pkg())['version']);
  });
});

describe('the container can be given every key the registry wants', () => {
  test('compose passes each provider variable through', async () => {
    // A provider added to the registry but not to the compose file cannot be
    // configured by anybody running the container — the deployment the README
    // leads with. Nothing fails; the provider is simply always skipped.
    const [raw, compose] = await Promise.all([
      readFile(resolve(ROOT, 'providers.default.json'), 'utf8'),
      readFile(resolve(ROOT, 'docker-compose.yml'), 'utf8'),
    ]);
    const registry = JSON.parse(raw) as {
      providers: Array<{ apiKeyEnv: string; accountIdEnv?: string }>;
    };
    const needed = new Set<string>();
    for (const p of registry.providers) {
      needed.add(p.apiKeyEnv);
      if (p.accountIdEnv) needed.add(p.accountIdEnv);
    }
    const missing = [...needed].filter((v) => !compose.includes(`${v}:`)).sort();
    assert.deepEqual(missing, [], `not passed into the container: ${missing.join(', ')}`);
  });
});
