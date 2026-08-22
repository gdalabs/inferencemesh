import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import {
  compareToRegistry,
  judgeReply,
  hasNativePrompt,
  judgeLanguage,
  promptsFor,
  summarise,
  type LanguageJudgement,
} from '../src/language-probe.js';

/**
 * Replies of the shape the probe prompts actually elicit. The judge is checked
 * against known-good text first: a detector that has never been shown a correct
 * answer can pass its negative cases by returning 'other' to everything.
 */
const JA = '空は灰色の雲に覆われ、風が少し湿ってきました。遠くで雷の音が聞こえます。';
const ZH = '天空被灰色的云层覆盖，风开始变得潮湿。远处传来雷声。';
const KO = '하늘이 회색 구름으로 덮이고 바람이 축축해졌습니다. 멀리서 천둥소리가 들립니다.';
const RU = 'Небо затянуто серыми тучами, а ветер стал влажным. Вдалеке слышны раскаты грома.';
const EN = 'The sky is covered with grey clouds and the air feels heavy before the rain arrives.';
const FR = "Le ciel est couvert de nuages gris et le vent devient humide avant l'orage qui arrive.";
const DE =
  'Der Himmel ist mit grauen Wolken bedeckt und der Wind wird feucht, bevor der Regen kommt.';

describe('judgeLanguage — a correct answer passes', () => {
  const cases: Array<[string, string, string]> = [
    ['ja', JA, 'Japanese'],
    ['zh', ZH, 'Chinese'],
    ['ko', KO, 'Korean'],
    ['ru', RU, 'Russian'],
    ['en', EN, 'English'],
    ['fr', FR, 'French'],
    ['de', DE, 'German'],
  ];
  for (const [tag, text, label] of cases) {
    test(`${label} reply matches '${tag}'`, () => {
      const j = judgeLanguage(text, tag);
      assert.equal(j.verdict, 'match', `${tag}: ${j.reason}`);
      assert.ok(j.share > 0, 'a match reports the share it saw');
    });
  }

  test('a regional tag falls back to its base language', () => {
    assert.equal(judgeLanguage(ZH, 'zh-Hans').verdict, 'match');
    assert.equal(judgeLanguage(EN, 'en-US').verdict, 'match');
  });
});

describe('judgeLanguage — answering in the wrong language is caught', () => {
  test('an English reply to a Japanese question is not a match', () => {
    const j = judgeLanguage(EN, 'ja');
    assert.equal(j.verdict, 'other');
    assert.equal(j.detected, 'en');
  });

  test('Chinese is not accepted as Japanese, which a Han count would allow', () => {
    const j = judgeLanguage(ZH, 'ja');
    assert.equal(j.verdict, 'other');
    assert.equal(j.detected, 'zh');
    assert.match(j.reason, /no kana/);
  });

  test('Japanese is not accepted as Chinese either', () => {
    const j = judgeLanguage(JA, 'zh');
    assert.equal(j.verdict, 'other');
    assert.equal(j.detected, 'ja');
  });

  test('a Latin-script neighbour is told apart by function words', () => {
    assert.equal(judgeLanguage(FR, 'de').verdict, 'other');
    assert.equal(judgeLanguage(FR, 'de').detected, 'fr');
    assert.equal(judgeLanguage(DE, 'en').detected, 'de');
  });

  test('a non-Latin reply to a Latin-language request is caught without stopwords', () => {
    const j = judgeLanguage(KO, 'en');
    assert.equal(j.verdict, 'other');
    assert.equal(j.detected, 'ko');
  });
});

describe('judgeLanguage — it says so when it cannot tell', () => {
  test('a language with no judge is unjudged, never a failure', () => {
    // Swahili, Latin script, no stopword set. Reporting 'other' here would
    // fault a model for an answer nobody checked.
    const sw = 'Anga limefunikwa na mawingu ya kijivu na upepo umeanza kuwa na unyevu.';
    assert.equal(judgeLanguage(sw, 'sw').verdict, 'unjudged');
  });

  test('Latin text too short to discriminate is unjudged, not other', () => {
    assert.equal(judgeLanguage('Grey clouds.', 'fr').verdict, 'unjudged');
  });

  test('a reply carrying no language is empty', () => {
    assert.equal(judgeLanguage('  42 — 3.14 ...  ', 'ja').verdict, 'empty');
    assert.equal(judgeLanguage('', 'en').verdict, 'empty');
  });

  test('a code block does not decide the language of the prose around it', () => {
    const reply = `空は灰色の雲に覆われています。\n\n\`\`\`python\nprint("the sky is grey and it is about to rain before the storm")\n\`\`\``;
    const j = judgeLanguage(reply, 'ja');
    assert.equal(j.verdict, 'match', j.reason);
  });

  test('proper nouns in Latin script do not sink a Japanese reply', () => {
    const j = judgeLanguage('Tokyo の空は灰色の雲に覆われ、雨が近づいています。', 'ja');
    assert.equal(j.verdict, 'match', j.reason);
  });
});

describe('probe prompts', () => {
  test('a language we ask in natively is flagged as such', () => {
    assert.equal(hasNativePrompt('ja'), true);
    assert.equal(hasNativePrompt('ja-JP'), true);
    assert.equal(hasNativePrompt('sw'), false);
  });

  test('every native prompt is itself written in its own language', () => {
    // The prompt is the measurement instrument. One written in English would
    // silently turn a competence probe into an instruction-following probe.
    for (const tag of ['ja', 'zh', 'ko', 'ru', 'ar', 'hi', 'th', 'fr', 'de', 'es', 'pt']) {
      for (const p of promptsFor(tag)) {
        assert.equal(judgeLanguage(p, tag).verdict, 'match', `${tag} prompt: ${p}`);
      }
    }
  });

  test('a language with no prompt falls back to an English instruction', () => {
    const [p] = promptsFor('sw');
    assert.match(p as string, /"sw"/);
  });
});

describe('summarise and compareToRegistry', () => {
  const j = (verdict: LanguageJudgement['verdict'], share = 0.9, detected?: string) =>
    ({ verdict, share, ...(detected ? { detected } : {}), reason: '' }) as LanguageJudgement;

  test('a summary counts each verdict and averages only the matches', () => {
    const s = summarise('ja', '2026-08-22', [j('match', 0.8), j('match', 1.0), j('other', 0, 'en')]);
    assert.equal(s.matched, 2);
    assert.equal(s.other, 1);
    assert.equal(s.meanShare, 0.9);
    assert.deepEqual(s.detected, ['en']);
    assert.equal(s.nativePrompts, true);
  });

  test('a claimed language the model never answers in is a fault', () => {
    const s = summarise('ja', '2026-08-22', [j('other', 0, 'en'), j('other', 0, 'en')]);
    assert.equal(compareToRegistry(s, 0.72), 'fault');
  });

  test('answering fine while rated low is understated, not a fault', () => {
    const s = summarise('ja', '2026-08-22', [j('match'), j('match')]);
    assert.equal(compareToRegistry(s, 0.2), 'understated');
  });

  test('a registry that claims nothing cannot be contradicted', () => {
    const s = summarise('ja', '2026-08-22', [j('match')]);
    assert.equal(compareToRegistry(s, undefined), 'no-claim');
  });

  test('nothing judged is inconclusive, never a fault', () => {
    const s = summarise('sw', '2026-08-22', [j('unjudged', 0), j('empty', 0)]);
    assert.equal(compareToRegistry(s, 0.9), 'inconclusive');
  });

  test('partial compliance agrees with a claim rather than faulting it', () => {
    const s = summarise('ja', '2026-08-22', [j('match'), j('other', 0, 'en')]);
    assert.equal(compareToRegistry(s, 0.72), 'agrees');
  });
});

describe('judgeLanguage — a reasoning model is not judged on its reasoning', () => {
  // Found by running it: llm7/minimax-m2.7 was reported as a Japanese failure
  // while it was, in English, deciding to answer in Japanese.
  const cot =
    'The user asks in Japanese, so we should respond in Japanese. No policy issues, we can comply.';

  test('a tagged think block does not decide the language', () => {
    const j = judgeLanguage(`<think>${cot}</think>\n${JA}`, 'ja');
    assert.equal(j.verdict, 'match', j.reason);
  });

  test('an unclosed think block leaves nothing to judge', () => {
    assert.equal(judgeLanguage(`<think>${cot}`, 'ja').verdict, 'empty');
  });

  test('a reply cut off at max_tokens is unjudged, never a fault', () => {
    // The whole reply is English reasoning because the budget ran out before
    // the answer. Calling this 'other' reports the probe's own token limit as
    // the model's fault, which is what the first live run did.
    const j = judgeReply(cot, 'ja', 'length');
    assert.equal(j.verdict, 'unjudged');
    assert.match(j.reason, /truncated/);
  });

  test('truncation cannot take away a match already demonstrated', () => {
    assert.equal(judgeReply(JA, 'ja', 'length').verdict, 'match');
  });

  test('without truncation the same English reply is still a fault', () => {
    assert.equal(judgeReply(cot, 'ja', 'stop').verdict, 'other');
  });
});
