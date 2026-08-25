import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Four READMEs stay in step, or they stop being translations.
 *
 * The English one is the original; the others are for people who cannot get an
 * API key in English, which is most of the audience this project was written
 * for. A translation that quietly falls behind is worse than none: it is
 * confidently wrong about the settings, the commands and the free-tier terms,
 * and the reader has no way to tell.
 *
 * These check the facts a translation cannot paraphrase away — variable names,
 * commands, defaults, numbers — not prose. Wording is a translator's business;
 * a missing `INFERENCEMESH_LEDGER` row is not.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LANGS = ['ja', 'ko', 'zh'] as const;

async function readme(lang?: string): Promise<string> {
  return readFile(resolve(ROOT, lang ? `README.${lang}.md` : 'README.md'), 'utf8');
}

describe('the translated READMEs', () => {
  test('each one exists and links to all the others', async () => {
    const files: Array<[string, string]> = [
      ['README.md', await readme()],
      ...(await Promise.all(
        LANGS.map(async (l): Promise<[string, string]> => [`README.${l}.md`, await readme(l)]),
      )),
    ];
    for (const [name, text] of files) {
      const head = text.slice(0, 400);
      for (const other of ['README.ja.md', 'README.ko.md', 'README.zh.md', 'README.md']) {
        if (other === name) continue;
        assert.ok(head.includes(other), `${name} does not link to ${other} near the top`);
      }
    }
  });

  test('every setting the server reads is documented in every language', async () => {
    // The same drift guard the English README already has, applied across all
    // four. A variable that exists in one and not the others is a reader in
    // that language who cannot configure the thing.
    const server = await readFile(resolve(ROOT, 'src/server/node.ts'), 'utf8');
    const used = new Set([...server.matchAll(/INFERENCEMESH_[A-Z_]+/g)].map((m) => m[0]));
    for (const lang of LANGS) {
      const text = await readme(lang);
      const missing = [...used].filter((v) => !text.includes(v)).sort();
      assert.deepEqual(missing, [], `README.${lang}.md is missing: ${missing.join(', ')}`);
    }
  });

  test('every command shown in English is shown in every language', async () => {
    const commands = new Set(
      [...(await readme()).matchAll(/inferencemesh (setup|serve|route|probe|sync|version)\b/g)].map(
        (m) => m[0],
      ),
    );
    assert.ok(commands.size >= 6, 'the English one shows the commands at all');
    for (const lang of LANGS) {
      const text = await readme(lang);
      const missing = [...commands].filter((c) => !text.includes(c)).sort();
      assert.deepEqual(missing, [], `README.${lang}.md never shows: ${missing.join(', ')}`);
    }
  });

  test('the numbers that are facts appear unchanged in every language', async () => {
    // A translated number is a number somebody can get wrong. These are all
    // measurements or defaults, and they are the parts a reader acts on.
    //
    // Each one is checked against the English first. The first version of this
    // list asserted `1048576`, which is in neither the original nor any
    // translation — a check failing on the translations for something the
    // source never said. A list of expected facts has to be held to the source
    // it claims to be checking, or it is just a list of guesses.
    const english = await readme();
    for (const fact of ['8910', '30000', '2098-12-31', '2026-08-22']) {
      assert.ok(english.includes(fact), `README.md does not contain ${fact} — fix the list`);
      for (const lang of LANGS) {
        assert.ok((await readme(lang)).includes(fact), `README.${lang}.md lost the value ${fact}`);
      }
    }
  });

  test('the licence is the same in all four', async () => {
    for (const lang of LANGS) {
      assert.match(await readme(lang), /MIT © GDA Labs/);
    }
  });
});
