import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FileKeyStore } from '../src/server/node.js';

/**
 * The file every provider key lands in on a self-hosted install.
 *
 * There is no server-side component anywhere else, so a key reaches exactly two
 * places: this file and the provider it belongs to. Losing one silently, or
 * writing it where somebody else can read it, are the two failures worth a test.
 */
async function store() {
  const dir = await mkdtemp(join(tmpdir(), 'im-keys-'));
  const path = join(dir, 'nested', 'keys');
  return { path, store: new FileKeyStore(path, '', {}) };
}

describe('FileKeyStore', () => {
  test('a saved key is readable back through env(), never through anything else', async () => {
    const { store: s } = await store();
    await s.save({ ALPHA_KEY: 'sk-alpha' });
    assert.equal(s.env()['ALPHA_KEY'], 'sk-alpha');
    // The interface has no get() by design; env() is the only way out, and it
    // feeds the Registry rather than any response.
    assert.equal('get' in s, false);
  });

  test('two saves at once keep both keys', async () => {
    // Each save is a read-modify-write through a temp file. Overlapping saves
    // both read the old contents, both write the temp file, and the second
    // rename wins with the first key missing — after the page said "OK".
    const { path, store: s } = await store();
    await Promise.all([s.save({ ALPHA_KEY: 'sk-alpha' }), s.save({ BETA_KEY: 'sk-beta' })]);
    const written = await readFile(path, 'utf8');
    assert.match(written, /^ALPHA_KEY=sk-alpha$/m);
    assert.match(written, /^BETA_KEY=sk-beta$/m);
    assert.deepEqual(
      { a: s.env()['ALPHA_KEY'], b: s.env()['BETA_KEY'] },
      { a: 'sk-alpha', b: 'sk-beta' },
    );
  });

  test('a burst of saves loses none of them', async () => {
    const { path, store: s } = await store();
    const keys = Array.from({ length: 12 }, (_, i) => `K${i}_KEY`);
    await Promise.all(keys.map((k, i) => s.save({ [k]: `sk-${i}` })));
    const written = await readFile(path, 'utf8');
    for (const [i, k] of keys.entries()) assert.match(written, new RegExp(`^${k}=sk-${i}$`, 'm'));
  });

  test('the file is not readable by anyone else', async () => {
    const { path, store: s } = await store();
    await s.save({ ALPHA_KEY: 'sk-alpha' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test('a rewrite keeps the mode, since it goes through a fresh temp file', async () => {
    const { path, store: s } = await store();
    await s.save({ ALPHA_KEY: 'sk-alpha' });
    await s.save({ BETA_KEY: 'sk-beta' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  test('keys survive a restart', async () => {
    const { path, store: s } = await store();
    await s.save({ ALPHA_KEY: 'sk-alpha' });
    const reopened = new FileKeyStore(path, '', {});
    await reopened.init();
    assert.equal(reopened.env()['ALPHA_KEY'], 'sk-alpha');
  });

  test('the process environment still wins nothing it did not set', async () => {
    const { path } = await store();
    const s = new FileKeyStore(path, '', { BASE_ONLY: 'from-env' });
    await s.save({ ALPHA_KEY: 'sk-alpha' });
    assert.equal(s.env()['BASE_ONLY'], 'from-env');
    assert.equal(s.env()['ALPHA_KEY'], 'sk-alpha');
  });
});
