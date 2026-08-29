#!/usr/bin/env node
/**
 * Write `docs/models.md` from `providers.default.json`.
 *
 * The inventory question — "what can I actually use, and what does it cost me
 * in quota" — is the first thing anyone asks and the last thing a hand-written
 * table answers correctly. A model leaves a free tier and the table is wrong
 * with nothing to notice it, which is the failure this repository keeps
 * finding in its own distribution.
 *
 * So the table is generated and a test regenerates it. Editing `docs/models.md`
 * by hand is pointless: the next run overwrites it and the test fails first.
 * Edit the registry, or edit this script.
 *
 *   node scripts/generate-models-doc.mjs           # write
 *   node scripts/generate-models-doc.mjs --check    # exit 1 if stale
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'docs/models.md');

/** A quota, as a phrase rather than a JSON blob. Absent stays absent. */
export function quotaText(q) {
  if (!q) return '—';
  const parts = [];
  if (q.requestsPerMinute != null) parts.push(`${q.requestsPerMinute}/min`);
  if (q.requestsPerDay != null) parts.push(`${q.requestsPerDay}/day`);
  if (q.tokensPerDay != null) parts.push(`${q.tokensPerDay.toLocaleString('en-US')} tok/day`);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * The price, or a refusal to guess at one.
 *
 * The first version of this function read `inputPerMTok ?? input ?? 0`. The
 * registry's fields are `inPerMTok` and `outPerMTok`, so every branch missed
 * and every model printed as **free** — including, had there been one, a model
 * that was not. A default of zero turns a typo into a claim about money, which
 * is the same failure the price rules in CLAUDE.md exist to prevent. An
 * unreadable price is reported as unreadable.
 */
export function priceText(model) {
  const p = model?.price;
  if (!p) return '—';
  const inp = p.inPerMTok;
  const out = p.outPerMTok;
  if (typeof inp !== 'number' || typeof out !== 'number') return '**unreadable**';
  if (inp === 0 && out === 0) return 'free';
  // `priceVerifiedAt` sits on the model entry, beside `price`, not inside it.
  // Reading it from the wrong object printed every future paid model without
  // the date that makes its price trustworthy — and the registry requires that
  // date for any non-zero price, so its absence here would look like a
  // violation that was not there.
  const verified = model.priceVerifiedAt ? ` (verified ${model.priceVerifiedAt})` : ' (**no verification date**)';
  return `$${inp} / $${out} per MTok${verified}`;
}

/** Unrated is not a rating, so it is shown as absent rather than as a middle value. */
export function qualityText(q) {
  return typeof q === 'number' ? q.toFixed(2) : '—';
}

export function render(registry) {
  const providers = registry.providers ?? [];
  const models = providers.flatMap((p) => p.models ?? []);
  const enabled = models.filter((m) => !m.disabled);
  // A provider with no key whose every model is disabled answers nothing, so
  // listing it under "no key required" would promise access that is not there.
  const keyless = providers.filter(
    (p) => !p.apiKeyEnv && (p.models ?? []).some((m) => !m.disabled),
  );

  const out = [];
  out.push('# What the shipped registry can reach');
  out.push('');
  out.push(
    '**Generated from `providers.default.json` — do not edit by hand.** Run',
    '`node scripts/generate-models-doc.mjs`; a test fails when this file and the',
    'registry disagree, so a model that leaves a free tier cannot quietly leave',
    'this page saying it is still there.',
  );
  out.push('');
  // Derived, not asserted. The shipped registry is free tiers only, but this
  // generator can render a price, so a sentence that hardcodes "everything is
  // free" would keep saying it while the table beside it showed a charge.
  const paid = models.filter((m) => {
    const p = m.price;
    return typeof p?.inPerMTok === 'number' && typeof p?.outPerMTok === 'number'
      && (p.inPerMTok !== 0 || p.outPerMTok !== 0);
  });
  out.push(`${providers.length} providers, ${models.length} models, ${enabled.length} of them enabled.`);
  if (paid.length === 0) {
    out.push(
      'Every model here is free to call. A non-zero price without a verification',
      'date fails validation, and paid entries belong in your own copy of',
      '`providers.example.json`, never in this one.',
    );
  } else {
    out.push(
      `⚠️ **${paid.length} model(s) below carry a non-zero price.** The shipped registry`,
      'is meant to be free tiers only — `0` is the one number that cannot go stale in',
      'a way that lies to you. Check these before shipping:',
      ...paid.map((m) => `- \`${m.id}\``),
    );
  }
  out.push('');
  out.push('A model is **disabled** when nothing has probed it, or when a probe found');
  out.push('it gone. Disabled entries are kept rather than deleted, because a');
  out.push('disappearance is the event worth seeing on the next diff.');
  out.push('');

  if (keyless.length) {
    out.push('## No key required');
    out.push('');
    out.push(
      `${keyless.map((p) => `\`${p.id}\``).join(', ')} answer without a key, which is why they`,
      'are the only providers this project can measure without spending somebody',
      "else's free tier.",
    );
    out.push('');
  }

  for (const p of providers) {
    const ms = p.models ?? [];
    const on = ms.filter((m) => !m.disabled).length;
    out.push(`## ${p.id}`);
    out.push('');
    const facts = [
      `**Key:** ${p.apiKeyEnv ? `\`${p.apiKeyEnv}\`` : 'none needed'}`,
      `**Privacy tier:** \`${p.maxPrivacy}\``,
      `**Enabled:** ${on}/${ms.length}`,
    ];
    if (p.quota) facts.push(`**Account-wide quota:** ${quotaText(p.quota)}`);
    if (p.maxConcurrent != null) facts.push(`**Max concurrent:** ${p.maxConcurrent}`);
    out.push(facts.join(' · '));
    out.push('');
    // `summary` and `freeTierNote` are deliberately not printed. Every one of
    // them is Japanese-only in the shipped registry today — the fields are typed
    // `string`, with no language dimension, unlike `signupSteps` which carries
    // `ja` and `en`. Rendering them here would put untranslated prose in an
    // English document. Print them once the registry can hold both.

    if (p.quota) {
      out.push(
        '> The quota above belongs to the **key**, not to each model: all of this',
        "> provider's models draw on the same budget.",
        '',
      );
    }
    out.push('| | Model | Context | Capabilities | Quota | Quality | Price |');
    out.push('|---|---|---:|---|---|---:|---|');
    for (const m of ms) {
      const mark = m.disabled ? '✗' : '✓';
      const caps = (m.capabilities ?? []).join(', ') || '—';
      const ctx = m.contextWindow != null ? m.contextWindow.toLocaleString('en-US') : '—';
      out.push(
        `| ${mark} | \`${m.id}\` | ${ctx} | ${caps} | ${quotaText(m.quota)} | ${qualityText(m.quality)} | ${priceText(m)} |`,
      );
    }
    out.push('');
    if (p.signupUrl) out.push(`Sign up: ${p.signupUrl}`, '');
  }

  out.push('## Reading the context column');
  out.push('');
  out.push(
    'For most providers it is the model\'s context window. For `orcarouter` it is',
    'not: the free tier refuses a request by **size** well below the catalogued',
    'window, and a 400 stops the fallback chain rather than moving on, so the',
    'number recorded is a measured floor rather than the advertised maximum. It',
    'was measured with ASCII; Japanese hits the limit sooner.',
  );
  out.push('');
  return out.join('\n');
}

// Importing this file must not run it. `cli.ts` taught the repository that
// lesson: a module that does its work on import cannot be unit-tested, and the
// pure half ends up untested precisely because it is the half worth testing.
const invokedDirectly =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (invokedDirectly) {
  const registry = JSON.parse(await readFile(resolve(ROOT, 'providers.default.json'), 'utf8'));
  const text = render(registry);

if (process.argv.includes('--check')) {
  const current = await readFile(OUT, 'utf8').catch(() => null);
  // Compared with line endings normalised. A CRLF checkout would otherwise
  // report a byte-identical document as stale on every run, and a check that
  // cries wolf is one that gets deleted.
  const norm = (t) => (t === null ? null : t.replace(/\r\n/g, '\n'));
  if (norm(current) !== norm(text)) {
    console.error('docs/models.md is out of date — run: node scripts/generate-models-doc.mjs');
    process.exitCode = 1;
  } else {
    console.log('docs/models.md is current');
  }
} else {
  await writeFile(OUT, text, 'utf8');
  console.log(`wrote ${OUT}`);
}
}
