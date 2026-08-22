import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { Readable, Writable } from 'node:stream';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mergeEnv, runSetup } from '../src/setup.js';
import type { ProviderConfig } from '../src/types.js';

describe('mergeEnv', () => {
  test('an existing value is replaced in place, not appended twice', () => {
    const out = mergeEnv('A=old\nB=keep\n', { A: 'new' });
    assert.equal(out, 'A=new\nB=keep\n');
  });

  test('a new value is appended', () => {
    assert.equal(mergeEnv('A=1\n', { B: '2' }), 'A=1\nB=2\n');
  });

  test('comments and unrelated lines survive', () => {
    // This file is the user's, and it is the only copy of keys they may have
    // pasted from a page that shows them once.
    const existing = '# my keys\nA=1\n\n# other\nOTHER=x\n';
    const out = mergeEnv(existing, { A: '2' });
    assert.match(out, /^# my keys$/m);
    assert.match(out, /^OTHER=x$/m);
    assert.match(out, /^A=2$/m);
  });

  test('an empty file gets a well-formed one line file', () => {
    assert.equal(mergeEnv('', { A: '1' }), 'A=1\n');
  });

  test('a value containing = is kept whole', () => {
    assert.equal(mergeEnv('', { A: 'sk-a=b=c' }), 'A=sk-a=b=c\n');
  });

  test('the result always ends in exactly one newline', () => {
    assert.equal(mergeEnv('A=1\n\n\n', { B: '2' }).endsWith('\n'), true);
    assert.equal(/\n\n$/.test(mergeEnv('A=1\n\n\n', { B: '2' })), false);
  });
});

/* -------------------------------------------------------------------------- */

function provider(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'testco',
    kind: 'openai-compat',
    baseUrl: 'https://example.invalid/v1',
    apiKeyEnv: 'TESTCO_KEY_FOR_SETUP_TEST',
    maxPrivacy: 'public',
    signupUrl: 'https://example.invalid/keys',
    models: [
      {
        id: 'm',
        capabilities: ['text'],
        contextWindow: 8000,
        price: { inPerMTok: 0, outPerMTok: 0 },
      },
    ],
    ...over,
  } as ProviderConfig;
}

/** Collects everything the wizard prints. */
function sink() {
  let text = '';
  const stream = new Writable({
    write(chunk, _enc, cb) {
      text += String(chunk);
      cb();
    },
  });
  return { stream, read: () => text };
}

/**
 * Drive the wizard the way a script or a UI would: through a pipe.
 *
 * `readline/promises` never settles its second question on non-TTY input and
 * Node exits with code 13 — the reason `lineReader` exists. Nothing catches a
 * regression there except a test that actually uses a pipe.
 */
async function drive(
  registry: unknown,
  answers: string[],
  opts: { verifies?: boolean[]; envPath?: string } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'im-setup-'));
  const envPath = opts.envPath ?? join(dir, '.env');
  const out = sink();
  const verdicts = [...(opts.verifies ?? [])];
  const asked: string[] = [];
  const code = await runSetup(registry, envPath, {
    input: Readable.from(answers.map((a) => `${a}\n`)),
    output: out.stream,
    async verifyKey(_p, key) {
      asked.push(key);
      return verdicts.shift() === false ? { ok: false, why: 'nope' } : { ok: true, ms: 5 };
    },
  });
  return { code, envPath, printed: out.read(), asked };
}

describe('runSetup over a pipe', () => {
  test('a verified key is written to the env file', async () => {
    const r = await drive({ providers: [provider()] }, ['sk-good']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.asked, ['sk-good']);
    assert.match(await readFile(r.envPath, 'utf8'), /^TESTCO_KEY_FOR_SETUP_TEST=sk-good$/m);
  });

  test('a pasted key is trimmed before it is checked', async () => {
    // Copying from a page that shows the key once brings the whitespace along,
    // and an untrimmed key fails hours later inside something else.
    const r = await drive({ providers: [provider()] }, ['  sk-spaced  ']);
    assert.deepEqual(r.asked, ['sk-spaced']);
  });

  test('a blank answer skips the provider and writes nothing', async () => {
    const r = await drive({ providers: [provider()] }, ['']);
    assert.equal(r.code, 0);
    assert.deepEqual(r.asked, []);
    await assert.rejects(() => readFile(r.envPath, 'utf8'));
  });

  test('a key that fails verification is not saved', async () => {
    const r = await drive({ providers: [provider()] }, ['sk-bad', 'n'], { verifies: [false] });
    assert.match(r.printed, /did not work/);
    await assert.rejects(() => readFile(r.envPath, 'utf8'), 'nothing is written');
  });

  test('answering y after a bad key asks again, and the second key is saved', async () => {
    const r = await drive({ providers: [provider()] }, ['sk-bad', 'y', 'sk-good'], {
      verifies: [false, true],
    });
    assert.deepEqual(r.asked, ['sk-bad', 'sk-good']);
    assert.match(await readFile(r.envPath, 'utf8'), /sk-good/);
  });

  test('input ending mid-wizard finishes instead of hanging', async () => {
    // End of input on a pipe. The whole reason readline is consumed as an
    // async iterator rather than with readline/promises.
    const r = await drive({ providers: [provider(), provider({ id: 'second' })] }, []);
    assert.equal(r.code, 0);
  });

  test('a keyless provider is reported, never prompted for', async () => {
    const r = await drive({ providers: [provider({ apiKeyOptional: true })] }, ['sk-never-asked']);
    assert.deepEqual(r.asked, []);
    assert.match(r.printed, /no key at all|鍵なし/);
  });

  test('a disabled provider is not offered', async () => {
    const r = await drive({ providers: [provider({ disabled: true })] }, ['']);
    assert.ok(!r.printed.includes('testco'));
  });

  test('an env file that already existed is tightened to 0600', async () => {
    // `writeFile`'s mode applies only when it creates the file. Every provider
    // key the user owns lands in this file; leaving it 0644 is how they end up
    // world-readable on a shared box.
    const dir = await mkdtemp(join(tmpdir(), 'im-setup-'));
    const envPath = join(dir, '.env');
    await writeFile(envPath, 'OLD=1\n', { mode: 0o644 });
    const r = await drive({ providers: [provider()] }, ['sk-good'], { envPath });
    assert.equal((await stat(r.envPath)).mode & 0o777, 0o600);
    assert.match(await readFile(r.envPath, 'utf8'), /^OLD=1$/m);
  });

  test('a registry with no providers is not a crash', async () => {
    // The embedded registry is loaded by the caller now; setup must cope with
    // whatever it gets rather than assuming a shape.
    assert.equal((await drive({}, [])).code, 0);
  });
});
