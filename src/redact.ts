/**
 * Local alias masking for prompts that must not train anyone's model.
 *
 * Free tiers keep the prompts — the registry says so on every provider page.
 * The honest answer to "don't let them learn this" is not a filter on where
 * the text may go (that is `maxPrivacy`) but a change to what goes out at
 * all: replace the names, companies, and figures with aliases on this
 * machine, send the aliased prompt, and restore the reply locally.
 *
 * What this guarantees, and what it does not:
 *
 * - The literal term never leaves the machine. If the model paraphrases the
 *   alias, echoes it, or drops it, the worst case is a bad answer — never a
 *   leak. That is the property that matters: failure degrades quality, not
 *   privacy.
 * - It does NOT hide the shape of the question. Sentence structure, topic,
 *   and domain all travel in the clear. "Someone asked about a merger" leaks
 *   even when neither party is named. Scattering the question itself across
 *   providers is a separate design (ROADMAP: shatter), not this module.
 * - Aliases are per-call and carry no meaning. `[[IMESH-E1]]` in one request
 *   is a different entity from `[[IMESH-E1]]` in the next — there is no table
 *   to steal because no table is sent.
 *
 * Pure, like everything else that must be testable without a key.
 */

const TOKEN = (i: number): string => `[[IMESH-E${i + 1}]]`;
const tokenPattern = (): RegExp => /\[\[IMESH-E(\d+)\]\]/g;
/** Terms shorter than this are skipped: masking "A" destroys the text. */
const MIN_SENSITIVE_LENGTH = 2;

export interface Redaction {
  /** The prompt with every listed term replaced by an alias. */
  redacted: string;
  /**
   * The terms in alias order: `entities[0]` is `[[IMESH-E1]]`.
   * Stays on this machine. Never sent anywhere.
   */
  entities: string[];
}

/**
 * Replace each term with an alias. Longest first, so "Tanaka Corp" wins
 * over "Tanaka" and the shorter one cannot eat half the longer one's match.
 *
 * Throws when the text already contains an alias token: silently reusing the
 * caller's own `[[IMESH-E1]]` as ours would corrupt the mapping on restore,
 * and inventing a second token scheme to dodge it would leave two dialects
 * for every later reader. Fail loudly instead.
 */
export function redact(text: string, sensitive: string[]): Redaction {
  if (tokenPattern().test(text)) {
    throw new Error('refusing to redact: text already contains an [[IMESH-En]] token');
  }
  const usable = [...new Set(sensitive.filter((s) => s.length >= MIN_SENSITIVE_LENGTH))].sort(
    (a, b) => b.length - a.length,
  );
  const entities: string[] = [];
  let redacted = text;
  for (const term of usable) {
    if (!redacted.includes(term)) continue;
    entities.push(term);
    redacted = redacted.split(term).join(TOKEN(entities.length - 1));
  }
  return { redacted, entities };
}

/**
 * Restore aliases to the original terms. Tokens with no entry in the table are left
 * alone: the model may invent `[[IMESH-E9]]` on its own, and guessing what it
 * meant would write words into a reply the model never said.
 */
export function restore(text: string, entities: string[]): string {
  return text.replace(tokenPattern(), (match, n: string) => {
    const entity = entities[Number(n) - 1];
    return entity === undefined ? match : entity;
  });
}
