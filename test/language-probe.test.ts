import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { declaredLanguageScore, languageScore } from '../src/registry.js';
import type { ModelEntry } from '../src/types.js';
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

describe('what the registry actually claims about a language', () => {
  const model = (languages?: Record<string, number>): ModelEntry => ({
    id: 'vendor/m',
    capabilities: ['text'],
    contextWindow: 8000,
    price: { inPerMTok: 0, outPerMTok: 0 },
    ...(languages ? { languages } : {}),
  });

  test('a language the entry never mentions is not a claim', () => {
    // languageScore falls back to DEFAULT_LANGUAGE_SCORE (0.6), which is above
    // the "this language is served" threshold. Reading that as a claim faults
    // a model for a language nobody said it spoke — the probe measuring its
    // own default instead of the file.
    const m = model({ en: 0.9 });
    assert.equal(languageScore(m, 'ja'), 0.6, 'routing still gets a number');
    assert.equal(declaredLanguageScore(m, 'ja'), undefined, 'the file said nothing');
    assert.equal(compareToRegistry(summarise('ja', '2026-08-22', []), undefined), 'inconclusive');
  });

  test('a wildcard is a claim about every language', () => {
    assert.equal(declaredLanguageScore(model({ en: 0.9, '*': 0.4 }), 'ja'), 0.4);
  });

  test('an exact tag beats the base language beats the wildcard', () => {
    const m = model({ 'zh-hant': 0.8, zh: 0.6, '*': 0.3 });
    assert.equal(declaredLanguageScore(m, 'zh-Hant'), 0.8);
    assert.equal(declaredLanguageScore(m, 'zh-Hans'), 0.6);
    assert.equal(declaredLanguageScore(m, 'ko'), 0.3);
  });

  test('an entry with no languages block claims nothing at all', () => {
    assert.equal(declaredLanguageScore(model(), 'ja'), undefined);
  });

  test('a claim of zero is still a claim, and is not a fault when honoured', () => {
    // 0 is falsy: a `||` here would turn "explicitly cannot do Japanese" into
    // "said nothing", and the model would never be reported as understated.
    const m = model({ ja: 0 });
    assert.equal(declaredLanguageScore(m, 'ja'), 0);
    const evidence = summarise('ja', '2026-08-22', [
      { verdict: 'match', share: 1, reason: '' },
      { verdict: 'match', share: 1, reason: '' },
    ]);
    assert.equal(compareToRegistry(evidence, 0), 'understated');
  });
});

describe('scripts that are their own answer', () => {
  // One sentence each, in the script the tag names. These languages have no
  // native probe prompt — writing one in a language nobody here can check
  // would make the instrument itself unverifiable — but a reply can still be
  // judged, which is what a user asking for `--language=el` needs.
  const cases: Array<[string, string, string]> = [
    ['he', 'השמיים מכוסים בעננים אפורים והרוח נעשית לחה לפני הגשם.', 'Hebrew'],
    ['el', 'Ο ουρανός είναι σκεπασμένος με γκρίζα σύννεφα πριν από τη βροχή.', 'Greek'],
    ['hy', 'Երկինքը ծածկված է մոխրագույն ամպերով անձրևից առաջ։', 'Armenian'],
    ['ka', 'ცა დაფარულია ნაცრისფერი ღრუბლებით წვიმის წინ.', 'Georgian'],
    ['bn', 'বৃষ্টির আগে আকাশ ধূসর মেঘে ঢাকা পড়েছে।', 'Bengali'],
    ['ta', 'மழைக்கு முன் வானம் சாம்பல் மேகங்களால் மூடப்பட்டுள்ளது.', 'Tamil'],
  ];
  for (const [tag, text, label] of cases) {
    test(`${label} is recognised as '${tag}'`, () => {
      const j = judgeLanguage(text, tag);
      assert.equal(j.verdict, 'match', `${tag}: ${j.reason}`);
    });

    test(`an English reply to a '${tag}' request is caught`, () => {
      assert.equal(judgeLanguage(EN, tag).verdict, 'other');
    });

    test(`${label} is not mistaken for another script's language`, () => {
      const j = judgeLanguage(text, 'ja');
      assert.equal(j.verdict, 'other');
      assert.equal(j.detected, tag, 'and it says what it actually saw');
    });
  }

  test('adding a script does not leave its counter behind', () => {
    // The tally is generated from the range table. When it was written out by
    // hand, a new script silently counted zero and every reply in it came back
    // `empty` — a detector that says "no language here" about a whole alphabet.
    for (const [, text] of cases) {
      assert.notEqual(judgeLanguage(text, 'xx').verdict, 'empty');
    }
  });

  test('a Greek letter in an English sentence does not make it Greek', () => {
    const maths = 'The angle θ is measured in radians and the sum is Σ over all terms here.';
    assert.equal(judgeLanguage(maths, 'en').verdict, 'match');
  });
});

describe('languages that share a script', () => {
  const UK = 'Небо вкрите сірими хмарами, і вітер стає вологим перед дощем. Чути грім вдалині.';
  const FA = 'آسمان پیش از باران با ابرهای خاکستری پوشیده شده و باد مرطوب می‌شود.';

  test('a Ukrainian reply does not confirm a Russian claim', () => {
    // The failure this exists for. A script check answers "is this Cyrillic",
    // and answering `match` there confirms a registry claim with evidence that
    // does not support it — worse than returning unjudged.
    const j = judgeLanguage(UK, 'ru');
    assert.equal(j.verdict, 'other', j.reason);
    assert.equal(j.detected, 'uk');
  });

  test('Russian is still Russian', () => {
    assert.equal(judgeLanguage(RU, 'ru').verdict, 'match');
  });

  test('Ukrainian can now be asked for on its own', () => {
    assert.equal(judgeLanguage(UK, 'uk').verdict, 'match');
  });

  test('a Russian reply to a Ukrainian request is caught', () => {
    const j = judgeLanguage(RU, 'uk');
    assert.equal(j.verdict, 'other');
    assert.equal(j.detected, 'ru');
  });

  test('Persian does not pass as Arabic', () => {
    const j = judgeLanguage(FA, 'ar');
    assert.equal(j.verdict, 'other', j.reason);
    assert.equal(j.detected, 'fa');
  });

  test('Arabic is still Arabic', () => {
    const ar = 'السماء مغطاة بغيوم رمادية قبل هطول المطر، والرياح تصبح رطبة.';
    assert.equal(judgeLanguage(ar, 'ar').verdict, 'match');
  });

  test('Cyrillic that gives nothing away stays a match rather than a guess', () => {
    // No і/ї/є/ґ and no ы/э/ъ. The letters do not separate the languages, so
    // the script verdict stands — the check may only reject, never invent.
    const ambiguous = 'Спасибо, до свидания.';
    assert.equal(judgeLanguage(ambiguous, 'ru').verdict, 'match');
    assert.equal(judgeLanguage(ambiguous, 'uk').verdict, 'match');
  });

  test('a mixture that names two languages at once is not a finding', () => {
    // Both alphabets' exclusive letters present: quoted text, or a model
    // switching mid-answer. Two votes is no vote.
    const mixed = `${UK} ${RU}`;
    assert.equal(judgeLanguage(mixed, 'ru').verdict, 'match');
  });

  test('identifying a non-matching reply uses the same refinement', () => {
    const j = judgeLanguage(UK, 'ja');
    assert.equal(j.detected, 'uk', 'not the script default');
  });
});
