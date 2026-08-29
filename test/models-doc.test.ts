import { strict as assert } from 'node:assert';
import { test, describe, before } from 'node:test';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = resolve(ROOT, 'scripts/generate-models-doc.mjs');
const DOC = resolve(ROOT, 'docs/models.md');

/**
 * `docs/models.md` is the inventory a reader trusts, and a hand-maintained one
 * would be wrong the first time a model left a free tier — with nothing to say
 * so. It is generated, and this is the thing that notices.
 *
 * The generator's pure half is exercised directly. An earlier version of this
 * file only asserted things about the *current* output — that it contained the
 * word `free` and no error marker — which the original bug would have passed:
 * reading the wrong field names and defaulting to 0 prints every model as free
 * and regenerates cleanly. Asserting on output shape does not test a reader.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let gen: any;
before(async () => {
  gen = await import(pathToFileURL(SCRIPT).href);
});

describe('the generated model inventory', () => {
  test('matches the registry it is generated from', async () => {
    await run(process.execPath, [SCRIPT, '--check'], { cwd: ROOT });
  });

  test('carries no Japanese, because it is an English-facing page', async () => {
    // Every `summary` and `freeTierNote` in the shipped registry is Japanese
    // today: those fields are typed `string` with no language dimension, unlike
    // `signupSteps`. The generator omits them for that reason, and this fails
    // if someone reinstates them before the registry can hold both languages.
    const text = await readFile(DOC, 'utf8');
    const jp = text.match(/[぀-ヿ一-鿿]/gu);
    assert.equal(jp, null, `untranslated prose reached the doc: ${jp?.slice(0, 8).join('')}`);
  });
});

describe('reading a price', () => {
  test('reads the fields the registry actually uses', () => {
    assert.equal(gen.priceText({ price: { inPerMTok: 0, outPerMTok: 0 } }), 'free');
    assert.match(
      gen.priceText({ price: { inPerMTok: 0.15, outPerMTok: 0.6 }, priceVerifiedAt: '2026-08-29' }),
      /\$0\.15 \/ \$0\.6 per MTok \(verified 2026-08-29\)/,
    );
  });

  test('a price it cannot read is never reported as free', () => {
    // This is the original defect, pinned: the generator was written against
    // `inputPerMTok`/`outputPerMTok`, which the registry does not use, and a
    // `?? 0` turned every miss into a claim that the model costs nothing.
    const wrongFields = { price: { inputPerMTok: 0, outputPerMTok: 0 } };
    assert.equal(gen.priceText(wrongFields), '**unreadable**');
    assert.equal(gen.priceText({ price: { inPerMTok: 0 } }), '**unreadable**');
    assert.equal(gen.priceText({}), '—');
  });

  test('a paid model with no verification date says so', () => {
    // The registry requires a date for any non-zero price. Rendering one
    // without the date silently, rather than loudly, would hide the violation.
    assert.match(
      gen.priceText({ price: { inPerMTok: 1, outPerMTok: 2 } }),
      /no verification date/,
    );
  });
});

describe('what the page claims about the registry as a whole', () => {
  test('does not call a registry free when it contains a charge', () => {
    const paid = gen.render({
      providers: [
        {
          id: 'p',
          maxPrivacy: 'public',
          models: [
            { id: 'costs-money', contextWindow: 1, capabilities: ['text'], price: { inPerMTok: 3, outPerMTok: 9 } },
          ],
        },
      ],
    });
    assert.ok(!paid.includes('Every model here is free to call'), 'claimed free while charging');
    assert.match(paid, /non-zero price/);
    assert.match(paid, /costs-money/);
  });

  test('does not advertise a keyless provider that can answer nothing', () => {
    const allOff = gen.render({
      providers: [
        {
          id: 'silent',
          maxPrivacy: 'public',
          models: [{ id: 'm', contextWindow: 1, capabilities: ['text'], price: { inPerMTok: 0, outPerMTok: 0 }, disabled: true }],
        },
      ],
    });
    assert.ok(!allOff.includes('## No key required'), 'offered a provider with nothing enabled');
  });
});
