/**
 * Measuring whether a model actually answers in the language it was asked in.
 *
 * `languages` in the registry is hand-written estimate today. That is the wrong
 * way round: for a non-English caller it is the single term that decides the
 * answer's usability, and it is the one term nobody measured. This module is
 * the measurable half — pure, offline, and testable against captured replies.
 *
 * What it measures is deliberately narrow. **Compliance, not competence.**
 * "Did it reply in Japanese at all" is a question a script histogram can answer
 * honestly; "how good is its Japanese" is not, and inventing a 0..1 from a
 * passing reply would be the same failure as an unverified price — a plausible
 * number that reorders `best` and that nothing ever corrects. So the verdict
 * here is a hard fact, and it is kept apart from the human `languages` score
 * exactly the way `sync` keeps `evidencePrivacy` apart from `maxPrivacy`.
 *
 * A language this module cannot judge returns `unjudged`. It never returns
 * `other` because it did not know how to look — absent is not denied.
 */

import type { LanguageTag } from './types.js';

export type LanguageVerdict =
  /** Replied in the requested language. */
  | 'match'
  /** Replied, identifiably, in some other language. */
  | 'other'
  /** Replied with nothing that carries a language (empty, digits, punctuation). */
  | 'empty'
  /** No judge for this language, or too little signal to call it either way. */
  | 'unjudged';

export interface LanguageJudgement {
  verdict: LanguageVerdict;
  /**
   * Share, 0..1, of the language-bearing text that belongs to the requested
   * language. Meaningful only when the verdict is `match` or `other`.
   */
  share: number;
  /** What it looked like instead, when that is identifiable. */
  detected?: LanguageTag;
  /** Why this verdict, in one phrase, for the report. */
  reason: string;
}

/**
 * A question in the target language whose answer cannot be a bare number or a
 * proper noun — a reply has to commit to a language to answer at all.
 *
 * These exist per language rather than "reply in X" in English on purpose:
 * an English instruction measures instruction-following, and a model can obey
 * it in a language it writes badly. Asking in the language itself is the same
 * thing a real caller does.
 */
export const PROBE_PROMPTS: Record<LanguageTag, string[]> = {
  ja: [
    '雨が降りそうな空の様子を、2文で説明してください。',
    'コーヒーとお茶の違いを、3つ挙げて短く説明してください。',
  ],
  zh: [
    '请用两句话描述快要下雨的天空。',
    '请简短说明咖啡和茶的三点不同。',
  ],
  ko: [
    '비가 올 것 같은 하늘을 두 문장으로 설명해 주세요.',
    '커피와 차의 차이점을 세 가지만 짧게 설명해 주세요.',
  ],
  ru: [
    'Опишите двумя предложениями небо перед дождём.',
    'Кратко назовите три отличия кофе от чая.',
  ],
  ar: [
    'صف السماء قبل هطول المطر في جملتين.',
    'اذكر باختصار ثلاثة فروق بين القهوة والشاي.',
  ],
  hi: [
    'बारिश से पहले के आसमान का दो वाक्यों में वर्णन कीजिए।',
    'कॉफ़ी और चाय के तीन अंतर संक्षेप में बताइए।',
  ],
  th: [
    'อธิบายท้องฟ้าก่อนฝนตกด้วยสองประโยค',
    'บอกความแตกต่างสามข้อระหว่างกาแฟกับชาสั้น ๆ',
  ],
  en: [
    'Describe the sky just before it rains, in two sentences.',
    'Name three differences between coffee and tea, briefly.',
  ],
  es: [
    'Describe en dos frases el cielo justo antes de que llueva.',
    'Menciona brevemente tres diferencias entre el café y el té.',
  ],
  fr: [
    'Décrivez en deux phrases le ciel juste avant la pluie.',
    'Citez brièvement trois différences entre le café et le thé.',
  ],
  de: [
    'Beschreiben Sie in zwei Sätzen den Himmel kurz vor dem Regen.',
    'Nennen Sie kurz drei Unterschiede zwischen Kaffee und Tee.',
  ],
  pt: [
    'Descreva em duas frases o céu pouco antes de chover.',
    'Cite brevemente três diferenças entre o café e o chá.',
  ],
};

/**
 * Whether a prompt exists for this tag. A tag without one can still be probed
 * — the caller falls back to an English instruction — but the report has to say
 * so, because that measures something different.
 */
export function hasNativePrompt(tag: LanguageTag): boolean {
  return baseTag(tag) in PROBE_PROMPTS;
}

export function promptsFor(tag: LanguageTag): string[] {
  const base = baseTag(tag);
  return (
    PROBE_PROMPTS[base] ?? [
      `Answer only in the language with BCP-47 tag "${tag}". Describe the sky just before it rains, in two sentences.`,
    ]
  );
}

function baseTag(tag: LanguageTag): string {
  return (tag.toLowerCase().split('-')[0] ?? tag).trim();
}

/** Scripts we can count. Latin is a bucket, not a language. */
type Script =
  | 'kana'
  | 'han'
  | 'hangul'
  | 'cyrillic'
  | 'arabic'
  | 'devanagari'
  | 'thai'
  | 'hebrew'
  | 'greek'
  | 'armenian'
  | 'georgian'
  | 'bengali'
  | 'tamil'
  | 'latin';

const SCRIPT_RANGES: Array<[Script, RegExp]> = [
  ['kana', /[぀-ヿㇰ-ㇿ]/],
  ['han', /[㐀-䶿一-鿿豈-﫿]/],
  ['hangul', /[가-힯ᄀ-ᇿ㄰-㆏]/],
  ['cyrillic', /[Ѐ-ӿ]/],
  ['arabic', /[؀-ۿݐ-ݿ]/],
  ['devanagari', /[ऀ-ॿ]/],
  ['thai', /[฀-๿]/],
  ['hebrew', /[\u0590-\u05ff\ufb1d-\ufb4f]/],
  // Greek and Coptic plus Greek Extended. Excludes the maths symbols that
  // share letterforms, which appear in English text about algebra.
  ['greek', /[\u0370-\u03ff\u1f00-\u1fff]/],
  ['armenian', /[\u0530-\u058f]/],
  ['georgian', /[\u10a0-\u10ff\u1c90-\u1cbf]/],
  ['bengali', /[\u0980-\u09ff]/],
  ['tamil', /[\u0b80-\u0bff]/],
  ['latin', /[A-Za-z\u00c0-\u024f\u1e00-\u1eff]/],
];

/** Language tag reported when a script is unambiguous on its own. */
const SCRIPT_LANGUAGE: Partial<Record<Script, LanguageTag>> = {
  hangul: 'ko',
  cyrillic: 'ru',
  arabic: 'ar',
  devanagari: 'hi',
  thai: 'th',
  hebrew: 'he',
  greek: 'el',
  armenian: 'hy',
  georgian: 'ka',
  bengali: 'bn',
  tamil: 'ta',
};

/**
 * Languages that share a script, and the letters that give each one away.
 *
 * A script check alone answers "is this Cyrillic", which is not the question
 * when the request was Russian and the reply is Ukrainian. That case is worse
 * than an unjudged one: it reports a match, so a registry claim gets confirmed
 * by evidence that does not support it.
 *
 * `only` is letters that appear in that language and not in its neighbours
 * here — not a full alphabet. The test is deliberately weak in one direction:
 * seeing another language's exclusive letters and none of the requested
 * language's is enough to say "not this one", while seeing nothing either way
 * leaves the script verdict alone. Distinguishing every pair is a research
 * problem; refusing to confirm the obvious mismatches is not.
 */
interface ScriptVariant {
  tag: LanguageTag;
  only: RegExp;
}

const SCRIPT_VARIANTS: Partial<Record<Script, ScriptVariant[]>> = {
  cyrillic: [
    // і ї є ґ are Ukrainian; Russian writes и and has ы э ъ, which Ukrainian
    // does not. Belarusian also has і, and is not separated from Ukrainian
    // here — it would need ў, and nobody has asked for `be` yet.
    { tag: 'uk', only: /[іїєґ]/i },
    { tag: 'ru', only: /[ыэъ]/i },
    { tag: 'sr', only: /[ђјљњћџ]/i },
  ],
  arabic: [
    // The four Persian letters. Urdu has them too, plus retroflexes of its own.
    { tag: 'ur', only: /[ٹڈڑںے]/ },
    { tag: 'fa', only: /[پچژگ]/ },
    { tag: 'ar', only: /[ةًٌٍ]/ },
  ],
};

/** Every language tag this module can judge from a script. */
const SCRIPT_OF_TAG = new Map<string, Script>();
for (const [script, tag] of Object.entries(SCRIPT_LANGUAGE) as Array<[Script, LanguageTag]>) {
  SCRIPT_OF_TAG.set(tag, script);
}
for (const [script, variants] of Object.entries(SCRIPT_VARIANTS) as Array<[Script, ScriptVariant[]]>) {
  for (const v of variants) SCRIPT_OF_TAG.set(v.tag, script);
}

/**
 * Within one script, which of its languages does this text look like?
 *
 * Returns the tag only when the letters actually say so. Null means the text
 * carries nothing that separates them, which is the common case for a short
 * reply and must not be read as agreement with whatever was asked.
 */
function variantOf(script: Script, text: string): LanguageTag | null {
  const variants = SCRIPT_VARIANTS[script];
  if (!variants) return null;
  const seen = variants.filter((v) => v.only.test(text));
  return seen.length === 1 ? (seen[0] as ScriptVariant).tag : null;
}

/**
 * Count the language-bearing characters by script.
 *
 * The tally is built from `SCRIPT_RANGES` rather than written out, so adding a
 * script cannot leave a counter behind — a hand-kept parallel list is exactly
 * the thing that goes quietly out of sync and makes a detector return zero for
 * a script it claims to support.
 */
function scriptCounts(text: string): Record<Script, number> & { total: number } {
  const counts = { total: 0 } as Record<Script, number> & { total: number };
  for (const [script] of SCRIPT_RANGES) counts[script] = 0;
  for (const ch of text) {
    for (const [script, re] of SCRIPT_RANGES) {
      if (re.test(ch)) {
        counts[script]++;
        counts.total++;
        break;
      }
    }
  }
  return counts;
}

/**
 * Function words, which a language uses constantly and a neighbour does not.
 * Only ever used to tell *these* languages apart — never as proof that text is
 * one of them, since a Latin-script language absent from this table would match
 * none of the sets and must come back `unjudged`, not `other`.
 */
const STOPWORDS: Record<string, string[]> = {
  en: ['the', 'and', 'is', 'of', 'to', 'a', 'it', 'that', 'with', 'are', 'before', 'you', 'in', 'on', 'for', 'this', 'two', 'three'],
  es: ['el', 'la', 'los', 'las', 'de', 'del', 'que', 'y', 'en', 'un', 'una', 'con', 'para', 'antes', 'se', 'por', 'no', 'es', 'dos', 'tres'],
  fr: ['le', 'la', 'les', 'des', 'de', 'du', 'et', 'est', 'un', 'une', 'dans', 'que', 'pour', 'avant', 'au', 'aux', 'ce', 'sur', 'deux', 'trois'],
  de: ['der', 'die', 'das', 'den', 'dem', 'und', 'ist', 'ein', 'eine', 'nicht', 'mit', 'von', 'zu', 'vor', 'im', 'sie', 'auch', 'aber', 'wie', 'sind', 'zwei', 'drei'],
  pt: ['o', 'a', 'os', 'as', 'de', 'do', 'da', 'que', 'e', 'em', 'um', 'uma', 'com', 'para', 'antes', 'não', 'por', 'duas', 'três'],
  it: ['il', 'lo', 'la', 'di', 'che', 'e', 'un', 'una', 'con', 'per', 'non', 'prima', 'del', 'nel', 'sono', 'due', 'tre'],
  nl: ['de', 'het', 'een', 'en', 'is', 'van', 'in', 'niet', 'met', 'voor', 'dat', 'zijn', 'op', 'twee', 'drie'],
  id: ['dan', 'yang', 'di', 'itu', 'dengan', 'untuk', 'tidak', 'adalah', 'dari', 'sebelum', 'ini', 'pada', 'dua', 'tiga'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'daha', 'olarak', 'değil', 'önce', 'olan', 'iki', 'üç'],
  pl: ['i', 'w', 'nie', 'na', 'jest', 'to', 'że', 'się', 'z', 'przed', 'do', 'dwa', 'trzy'],
  vi: ['và', 'của', 'là', 'không', 'một', 'những', 'trong', 'với', 'trước', 'các', 'hai', 'ba'],
};

/** Latin-script languages we have no stopword set for stay unjudged. */
const LATIN_JUDGEABLE = new Set(Object.keys(STOPWORDS));

interface LatinGuess {
  tag: string;
  share: number;
  hits: number;
  tokens: number;
}

function guessLatin(text: string): LatinGuess | null {
  const tokens = text
    .toLowerCase()
    .split(/[^a-z\u00df-\u024f\u1e00-\u1eff]+/)
    .filter(Boolean);
  // Two or three words can hit one set by accident; below this there is no
  // signal, and reporting a guess as a measurement is the failure mode here.
  if (tokens.length < 8) return null;
  const ranked: LatinGuess[] = [];
  for (const [tag, words] of Object.entries(STOPWORDS)) {
    const set = new Set(words);
    const hits = tokens.filter((t) => set.has(t)).length;
    ranked.push({ tag, share: hits / tokens.length, hits, tokens: tokens.length });
  }
  ranked.sort((a, b) => b.hits - a.hits);
  const best = ranked[0];
  // A language that is in the table would show its function words. Below this
  // the text is Latin-script but none of the ones we know.
  if (!best || best.hits < 2) return null;
  // Two sets fitting equally well is not a measurement. Sibling languages share
  // function words ('de', 'in', 'la'), and picking whichever came first in the
  // table would report a coin toss as a finding.
  if (ranked[1] && ranked[1].hits === best.hits) return null;
  return best;
}


/**
 * Everything in a reply that is not the answer.
 *
 * Code fences go because a code block is English-shaped in every language, and
 * counting one would fail a model that answered correctly and then illustrated.
 *
 * Reasoning goes for a sharper reason. A thinking model narrates in English
 * before answering in the language it was asked in — the first run of this
 * probe called `minimax-m2.7` a Japanese failure while it was, in English,
 * deciding to answer in Japanese. An unclosed `<think>` is stripped to the end:
 * a reply cut off mid-thought contains no answer at all, and the caller marks
 * that truncated rather than wrong.
 */
export function stripNonAnswer(text: string): string {
  return text
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(think|thinking|reasoning)>[\s\S]*$/i, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .trim();
}

/**
 * Grade a reply together with how it ended.
 *
 * A reply the provider cut off at `max_tokens` is not evidence of anything: a
 * thinking model spends its budget in English and never reaches the answer, so
 * scoring it `other` reports the probe's own token limit as the model's fault.
 * Truncation can only ever soften a verdict — a truncated reply already in the
 * right language has demonstrated exactly what was asked.
 */
export function judgeReply(
  text: string,
  tag: LanguageTag,
  finishReason?: string | null,
): LanguageJudgement {
  const j = judgeLanguage(text, tag);
  if (finishReason === 'length' && j.verdict !== 'match') {
    return {
      verdict: 'unjudged',
      share: 0,
      reason: `reply truncated at max_tokens before an answer (${j.reason})`,
    };
  }
  return j;
}

/**
 * Grade one reply against the language it was asked for.
 *
 * `text` should be the model's message content and nothing else; code fences
 * and reasoning blocks are removed first (see `stripNonAnswer`). Prefer
 * `judgeReply`, which also knows what a truncated reply is worth.
 */
export function judgeLanguage(text: string, tag: LanguageTag): LanguageJudgement {
  const cleaned = stripNonAnswer(text);
  const want = baseTag(tag);
  const counts = scriptCounts(cleaned);

  if (counts.total === 0) {
    return { verdict: 'empty', share: 0, reason: 'no language-bearing characters in the reply' };
  }

  const share = (n: number) => n / counts.total;

  // Japanese is the case a plain Han count gets wrong: Japanese without kana is
  // Chinese. Kana is the discriminator, and it has to be present, not merely
  // dominant — a mostly-Han sentence with particles in kana is normal Japanese.
  if (want === 'ja') {
    const jp = share(counts.kana + counts.han);
    if (counts.kana === 0) {
      const detected: LanguageTag | undefined =
        counts.han > 0 ? 'zh' : identifyOther(counts, cleaned);
      return {
        verdict: 'other',
        share: 0,
        ...(detected ? { detected } : {}),
        reason: counts.han > 0 ? 'Han characters but no kana — this is Chinese' : 'no Japanese script',
      };
    }
    return jp >= 0.5
      ? { verdict: 'match', share: jp, reason: `${pct(jp)} Japanese script` }
      : {
          verdict: 'other',
          share: jp,
          ...(identifyOther(counts, cleaned) ? { detected: identifyOther(counts, cleaned) as LanguageTag } : {}),
          reason: `only ${pct(jp)} Japanese script`,
        };
  }

  if (want === 'zh') {
    if (counts.kana > 0 && counts.kana / (counts.kana + counts.han || 1) > 0.1) {
      return { verdict: 'other', share: 0, detected: 'ja', reason: 'kana present — this is Japanese' };
    }
    const zh = share(counts.han);
    return zh >= 0.5
      ? { verdict: 'match', share: zh, reason: `${pct(zh)} Han` }
      : { verdict: 'other', share: zh, ...(identifyOther(counts, cleaned) ? { detected: identifyOther(counts, cleaned) as LanguageTag } : {}), reason: `only ${pct(zh)} Han` };
  }

  const wantScript = SCRIPT_OF_TAG.get(want);
  if (wantScript) {
    const s = share(counts[wantScript]);
    if (s < 0.5) {
      const detected = identifyOther(counts, cleaned);
      return {
        verdict: 'other',
        share: s,
        ...(detected ? { detected } : {}),
        reason: `only ${pct(s)} ${wantScript}`,
      };
    }
    // Right script, possibly the wrong language in it.
    const variant = variantOf(wantScript, cleaned);
    if (variant && variant !== want) {
      return {
        verdict: 'other',
        share: s,
        detected: variant,
        reason: `${wantScript} script, but the letters are ${variant}, not ${want}`,
      };
    }
    return { verdict: 'match', share: s, reason: `${pct(s)} ${wantScript}` };
  }

  if (LATIN_JUDGEABLE.has(want)) {
    // A non-Latin script dominating the reply settles it without stopwords.
    const nonLatin = counts.total - counts.latin;
    if (nonLatin / counts.total > 0.5) {
      const detected = identifyOther(counts, cleaned);
      return {
        verdict: 'other',
        share: share(counts.latin),
        ...(detected ? { detected } : {}),
        reason: 'reply is not in Latin script',
      };
    }
    const guess = guessLatin(cleaned);
    if (!guess) {
      return { verdict: 'unjudged', share: 0, reason: 'too little Latin-script text to tell languages apart' };
    }
    return guess.tag === want
      ? { verdict: 'match', share: guess.share, reason: `${guess.hits}/${guess.tokens} ${want} function words` }
      : {
          verdict: 'other',
          share: 0,
          detected: guess.tag,
          reason: `function words match ${guess.tag}, not ${want}`,
        };
  }

  return { verdict: 'unjudged', share: 0, reason: `no judge for language '${tag}'` };
}

/** Best identification of a reply that is not in the requested language. */
function identifyOther(
  counts: Record<Script, number> & { total: number },
  cleaned: string,
): LanguageTag | undefined {
  let top: Script | null = null;
  for (const [script] of SCRIPT_RANGES) {
    if (!top || counts[script] > counts[top]) top = script;
  }
  if (!top || counts[top] === 0) return undefined;
  if (top === 'kana') return 'ja';
  if (top === 'han') return counts.kana > 0 ? 'ja' : 'zh';
  if (top === 'latin') return guessLatin(cleaned)?.tag;
  return variantOf(top, cleaned) ?? SCRIPT_LANGUAGE[top];
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/**
 * The measured fact about one model and one language, over several replies.
 * This is evidence, not a rating — it is reported and diffed, never merged into
 * the hand-written `languages` score.
 */
export interface LanguageEvidence {
  language: LanguageTag;
  /** YYYY-MM-DD the measurement was taken. */
  measuredAt: string;
  /** Replies that came back in the requested language. */
  matched: number;
  /** Replies that came back in some other identifiable language. */
  other: number;
  /** Replies nothing could be concluded from. */
  unjudged: number;
  /** Mean script/function-word share across matched replies. */
  meanShare: number;
  /** What it answered in instead, when it did not comply. */
  detected?: LanguageTag[];
  /** Whether the prompts were written in the target language. */
  nativePrompts: boolean;
}

export function summarise(
  language: LanguageTag,
  measuredAt: string,
  judgements: LanguageJudgement[],
): LanguageEvidence {
  const matched = judgements.filter((j) => j.verdict === 'match');
  const other = judgements.filter((j) => j.verdict === 'other');
  const unjudged = judgements.filter((j) => j.verdict === 'unjudged' || j.verdict === 'empty');
  const detected = [...new Set(other.map((j) => j.detected).filter(Boolean))] as LanguageTag[];
  return {
    language,
    measuredAt,
    matched: matched.length,
    other: other.length,
    unjudged: unjudged.length,
    meanShare: matched.length ? matched.reduce((a, j) => a + j.share, 0) / matched.length : 0,
    ...(detected.length ? { detected } : {}),
    nativePrompts: hasNativePrompt(language),
  };
}

/**
 * How the measurement disagrees with what the registry claims.
 *
 * Only one direction is a fault. A model the registry rates as usable in a
 * language and which will not answer in it is rot — the same class of thing
 * `probe` already exits non-zero for. The opposite, a model rated low that
 * answers fine, is understated: worth reporting, worth nobody's alert.
 */
export type LanguageDisagreement = 'fault' | 'understated' | 'agrees' | 'no-claim' | 'inconclusive';

/** Registry scores at or above this are a claim the language is usable. */
export const USABLE_LANGUAGE_SCORE = 0.5;
/** Registry scores below this claim the language is not really served. */
export const WEAK_LANGUAGE_SCORE = 0.3;

export function compareToRegistry(
  evidence: LanguageEvidence,
  claimed: number | undefined,
): LanguageDisagreement {
  const judged = evidence.matched + evidence.other;
  if (judged === 0) return 'inconclusive';
  const complied = evidence.matched / judged;
  if (claimed === undefined) return 'no-claim';
  if (claimed >= USABLE_LANGUAGE_SCORE && complied === 0) return 'fault';
  if (claimed < WEAK_LANGUAGE_SCORE && complied === 1) return 'understated';
  return 'agrees';
}
