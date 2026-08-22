#!/usr/bin/env node
/**
 * CLI.
 *
 *   inferencemesh setup            walk through getting keys, verifying each one
 *   inferencemesh probe            call every candidate once and report what works
 *   inferencemesh probe --language=ja   check each one answers in that language
 *   inferencemesh route <profile>  explain a routing decision without any network
 *   inferencemesh serve            start the Node gateway
 *
 * `probe` exists because a registry file rots silently. Model ids get retired,
 * free tiers get withdrawn, and a key gets revoked — none of which produce an
 * error until a user is waiting on a reply. Probing turns all of that into an
 * exit code you can put on a schedule.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CATALOGS } from './catalogs.js';
import { VALID_CAPABILITIES, registryFrom, validateRegistryFile, type RegistryFile } from './config.js';
import { InferenceMesh } from './mesh.js';
import { Router } from './router.js';
import {
  compareToRegistry,
  hasNativePrompt,
  judgeReply,
  promptsFor,
  summarise,
  type LanguageJudgement,
} from './language-probe.js';
import { blendedPrice, declaredLanguageScore, maxPrivacyOf, type Registry } from './registry.js';
import { configFromEnv, loadRegistryFile, main as serveMain } from './server/node.js';
import { runSetup } from './setup.js';
import { EXPIRY_WARNING_DAYS, daysBetween, syncModels } from './sync.js';
import { attemptStatus, shortMessage, verdictFor } from './probe-report.js';
import { PRIVACY_ORDER, type Capability, type PrivacyLevel } from './types.js';

/**
 * A user error: one line, exit 2.
 *
 * It throws rather than calling `process.exit`, which terminates before
 * pending writes to a pipe are flushed — the same reason the exit code at the
 * bottom of this file is set rather than forced. The top-level handler prints
 * it and sets the code, so every way of getting a message out is the same one.
 */
class UsageError extends Error {}

function fail(msg: string): never {
  throw new UsageError(msg);
}

async function loadRegistry() {
  const cfg = configFromEnv();
  const raw = await loadRegistryFile(cfg.registryPath || null, cfg.registryPathExplicit);
  const registry = registryFrom(raw);
  for (const w of registry.warnings) {
    console.warn(`warn: provider '${w.providerId}' skipped: ${w.reason}`);
  }
  return registry;
}


/**
 * Free tiers that have announced their own end date.
 *
 * `sync` records `expiresAt` from a provider's catalog, and until now the only
 * place it appeared was the sync report — a command run when the registry is
 * being regenerated, which is not when you want to hear that a model you route
 * to stops existing on Monday. `probe` is the one people put on a schedule, so
 * it says so too.
 *
 * Nothing routes on this. It is a statement of intent by the provider, and a
 * model that outlives its own expiry keeps working; the date only decides what
 * gets said out loud.
 */
function expiryNotes(registry: Registry, today: string): string[] {
  const notes: string[] = [];
  for (const c of registry.candidates) {
    const when = c.model.expiresAt;
    if (!when) continue;
    const days = daysBetween(today, when);
    if (days === null || days > EXPIRY_WARNING_DAYS) continue;
    notes.push(
      days < 0
        ? `${c.key}: the catalog said this free tier ended ${when} — still listed, so probe it`
        : `${c.key}: this free tier is announced to end ${when} (${days} day(s) away)`,
    );
  }
  return notes;
}

async function cmdProbe(argv: string[]): Promise<number> {
  const registry = await loadRegistry();
  if (registry.candidates.length === 0) {
    console.error('no candidates: every provider was skipped (see warnings above)');
    return 1;
  }
  const only = argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
  const json = argv.includes('--json');
  const mesh = new InferenceMesh({ registry, timeoutMs: 30_000, maxAttempts: 1 });

  /**
   * A 429 is not the same finding as a 404.
   *
   * "This model id no longer exists" is rot and needs a human. "You are over
   * the free tier's rate limit right now" is the free tier working as designed,
   * and alerting on it every night is how a monitor teaches you to ignore it.
   * They are reported separately and only the first sets the exit code.
   */
  type Verdict = 'ok' | 'limited' | 'broken';
  const results: Array<{ key: string; verdict: Verdict; status?: number; ms: number; detail: string }> = [];

  for (const c of registry.candidates) {
    if (only && c.provider.id !== only) continue;
    const t0 = Date.now();
    try {
      const res = await mesh.chat({
        model: c.key,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      });
      const text = res.choices[0]?.message.content;
      results.push({
        key: c.key,
        verdict: 'ok',
        ms: Date.now() - t0,
        detail: typeof text === 'string' ? text.slice(0, 40).replace(/\s+/g, ' ') : '',
      });
    } catch (err) {
      const status = attemptStatus(err);
      results.push({
        key: c.key,
        verdict: verdictFor(status),
        ...(status ? { status } : {}),
        ms: Date.now() - t0,
        detail: shortMessage(err),
      });
    }
  }

  const broken = results.filter((r) => r.verdict === 'broken');
  const limited = results.filter((r) => r.verdict === 'limited');

  if (json) {
    console.log(
      JSON.stringify(
        { probedAt: new Date().toISOString(), ok: broken.length === 0, results },
        null,
        2,
      ),
    );
  } else {
    const label = { ok: 'ok   ', limited: 'limit', broken: 'BROKE' } as const;
    for (const r of results) {
      console.log(`${label[r.verdict]} ${r.key.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
    }
    console.log(
      `\n${results.length - broken.length - limited.length}/${results.length} reachable` +
        (limited.length ? `, ${limited.length} rate-limited (not a fault)` : '') +
        (broken.length ? `, ${broken.length} BROKEN` : ''),
    );
    for (const n of expiryNotes(registry, new Date().toISOString().slice(0, 10))) {
      console.log(`note  ${n}`);
    }
  }
  // Only rot sets the exit code. Being rate limited is the free tier working.
  return broken.length === 0 ? 0 : 1;
}

/**
 * `probe --language=ja` — does each candidate actually answer in that language?
 *
 * The registry's `languages` scores are hand-written estimates, which for a
 * non-English caller is the term that decides whether an answer is usable at
 * all. This asks each model a question written in the target language and
 * grades what comes back.
 *
 * It reports the measurement beside the claim and **never writes the claim**.
 * Compliance is not competence: answering in Japanese does not tell you how
 * good the Japanese is, and turning a pass into a 0..1 would put an invented
 * number where a measured one is supposed to go. Only one direction is a fault
 * — a language the registry says is served and the model will not answer in.
 */
async function cmdProbeLanguage(language: string, argv: string[]): Promise<number> {
  const registry = await loadRegistry();
  if (registry.candidates.length === 0) {
    console.error('no candidates: every provider was skipped (see warnings above)');
    return 1;
  }
  const only = argv.find((a) => a.startsWith('--provider='))?.split('=')[1];
  const json = argv.includes('--json');
  const prompts = promptsFor(language);
  const measuredAt = new Date().toISOString().slice(0, 10);
  const mesh = new InferenceMesh({ registry, timeoutMs: 60_000, maxAttempts: 1 });

  if (!hasNativePrompt(language) && !json) {
    console.warn(
      `warn: no prompt written in '${language}'; falling back to an English instruction, ` +
        'which measures instruction-following rather than the language itself',
    );
  }

  type Row = {
    key: string;
    claimed?: number;
    evidence?: ReturnType<typeof summarise>;
    disagreement: string;
    limited?: boolean;
    error?: string;
  };
  const rows: Row[] = [];

  for (const c of registry.candidates) {
    if (only && c.provider.id !== only) continue;
    // What the entry actually says — not what routing would score. A model
    // that claims nothing about this language cannot be contradicted by it.
    const claimed = declaredLanguageScore(c.model, language);
    const judgements: LanguageJudgement[] = [];
    let limited = false;
    let error: string | undefined;

    for (const prompt of prompts) {
      try {
        const res = await mesh.chat({
          model: c.key,
          messages: [{ role: 'user', content: prompt }],
          // Generous on purpose. A thinking model narrates its reasoning in
          // English first, and a budget that runs out mid-thought produces a
          // reply with no answer in it — which the judge then has to discard.
          max_tokens: 1024,
          temperature: 0,
        });
        const choice = res.choices[0];
        const text = choice?.message.content;
        judgements.push(
          judgeReply(typeof text === 'string' ? text : '', language, choice?.finish_reason),
        );
      } catch (err) {
        if (verdictFor(attemptStatus(err)) === 'limited') limited = true;
        else error = shortMessage(err, 120);
        break;
      }
    }

    if (judgements.length === 0) {
      rows.push({
        key: c.key,
        ...(claimed !== undefined ? { claimed } : {}),
        disagreement: limited ? 'rate-limited' : 'unreachable',
        ...(limited ? { limited } : {}),
        ...(error ? { error } : {}),
      });
      continue;
    }
    const evidence = summarise(language, measuredAt, judgements);
    rows.push({
      key: c.key,
      ...(claimed !== undefined ? { claimed } : {}),
      evidence,
      disagreement: compareToRegistry(evidence, claimed),
      ...(limited ? { limited } : {}),
    });
  }

  const faults = rows.filter((r) => r.disagreement === 'fault');
  // A candidate that produced at least one usable verdict. Everything else was
  // unreachable, rate-limited, or replied with nothing that could be judged.
  const judged = rows.filter((r) => (r.evidence?.matched ?? 0) + (r.evidence?.other ?? 0) > 0);

  if (json) {
    // `ok` alone is a trap for a scheduler: it is true when nothing was
    // measured at all. `judged` is what says whether `ok` means anything.
    console.log(
      JSON.stringify(
        { language, measuredAt, ok: faults.length === 0, judged: judged.length, results: rows },
        null,
        2,
      ),
    );
  } else {
    for (const r of rows) {
      const e = r.evidence;
      const measured = e
        ? `${e.matched}/${e.matched + e.other + e.unjudged} in ${language}`.padEnd(12) +
          (e.detected?.length ? `→ ${e.detected.join(',')}`.padEnd(10) : ''.padEnd(10))
        : (r.error ?? 'rate limited').slice(0, 22).padEnd(22);
      const claim = r.claimed === undefined ? 'unrated' : `claims ${r.claimed.toFixed(2)}`;
      const flag = r.disagreement === 'fault' ? 'FAULT' : r.disagreement;
      console.log(`${r.key.padEnd(46)} ${measured} ${claim.padEnd(12)} ${flag}`);
    }
    // "No contradictions" over zero measurements is the worst kind of green:
    // a run where every provider was unreachable or rate-limited looks exactly
    // like a clean bill of health. Say how many were actually judged.
    const unreached = rows.length - judged.length;
    console.log(
      `\n${rows.length} candidate(s) asked ${prompts.length} question(s) each in '${language}': ` +
        (judged.length === 0
          ? 'nothing was measured'
          : `${judged.length} judged, ` +
            (faults.length ? `${faults.length} FAULT` : 'no contradictions')) +
        (unreached ? ` (${unreached} not reached)` : ''),
    );
    console.log(
      'measured compliance, not competence — the registry\'s languages scores are not written by this command',
    );
  }
  return faults.length === 0 ? 0 : 1;
}

async function cmdRoute(argv: string[]): Promise<number> {
  const registry = await loadRegistry();
  const router = new Router(registry);
  const profile = argv[0] ?? registry.defaultProfile;
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const caps = arg('capabilities');

  // Arguments are checked before routing rather than being passed through.
  //
  // Every one of these used to be taken on trust, and each failed in a way that
  // blamed the registry instead of the typo: `--privacy=internel` rejected every
  // candidate with "needs internel", `--capabilities=tols` reported every model
  // as "missing tols", and `--min-context=abc` became NaN and filtered nothing
  // at all while looking like it had.
  const privacy = arg('privacy');
  if (privacy !== undefined && !(privacy in PRIVACY_ORDER)) {
    fail(`unknown privacy tier '${privacy}'. Known: ${Object.keys(PRIVACY_ORDER).join(', ')}`);
  }
  const capabilities = caps ? caps.split(',').map((c) => c.trim()).filter(Boolean) : undefined;
  for (const c of capabilities ?? []) {
    if (!VALID_CAPABILITIES.has(c)) {
      fail(`unknown capability '${c}'. Known: ${[...VALID_CAPABILITIES].join(', ')}`);
    }
  }
  const minContextArg = arg('min-context');
  let minContext: number | undefined;
  if (minContextArg !== undefined) {
    minContext = Number(minContextArg);
    if (!Number.isInteger(minContext) || minContext <= 0) {
      fail(`--min-context must be a positive integer (got '${minContextArg}')`);
    }
  }

  const decision = router.route({
    mesh: profile,
    ...(arg('language') ? { language: arg('language') as string } : {}),
    ...(privacy ? { privacy: privacy as PrivacyLevel } : {}),
    ...(capabilities?.length ? { capabilities: capabilities as Capability[] } : {}),
    ...(minContext !== undefined ? { minContext } : {}),
  });

  console.log(`profile: ${decision.profile.name}`);
  console.log('\nranked:');
  for (const [i, s] of decision.ranked.entries()) {
    const t = s.terms;
    console.log(
      `  ${i + 1}. ${s.candidate.key.padEnd(48)} score=${s.score.toFixed(3)}  ` +
        `q=${(t['quality'] ?? 0).toFixed(2)}${s.candidate.model.quality === undefined ? '?' : ' '}cost=${(t['cost'] ?? 0).toFixed(2)} ` +
        `lat=${(t['latency'] ?? 0).toFixed(2)} lang=${(t['language'] ?? 0).toFixed(2)}  ` +
        `$${blendedPrice(s.candidate.model).toFixed(2)}/MTok  ${maxPrivacyOf(s.candidate)}`,
    );
  }
  if (decision.rejected.length) {
    console.log('\nrejected:');
    for (const r of decision.rejected) console.log(`  - ${r.key.padEnd(48)} ${r.reason}`);
  }
  const notes = expiryNotes(registry, new Date().toISOString().slice(0, 10));
  if (notes.length) {
    console.log('\nending soon:');
    for (const n of notes) console.log(`  - ${n}`);
  }
  return decision.ranked.length > 0 ? 0 : 1;
}

/**
 * Generate registry entries from a provider's own catalog.
 *
 *   inferencemesh sync --provider=redpill --out=providers.local.json
 *
 * Machine facts are refreshed every run; `quality` and `languages` are never
 * written, because a catalog does not know them and a plausible guess is worse
 * than a gap. See src/sync.ts.
 */
async function cmdSync(argv: string[]): Promise<number> {
  const arg = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
  const dryRun = argv.includes('--dry-run');

  const which = arg('provider');
  if (!which) fail(`usage: inferencemesh sync --provider=<${Object.keys(CATALOGS).join('|')}> [--out=FILE] [--dry-run]`);
  const catalog = CATALOGS[which as string];
  if (!catalog) fail(`unknown catalog '${which}'. Known: ${Object.keys(CATALOGS).join(', ')}`);

  const out = resolve(arg('out') ?? `providers.${which}.json`);
  // The shipped registry is free tiers only — 0 is the one price that cannot go
  // stale in a way that lies to you. Generating paid entries into it would
  // quietly break that guarantee for everyone who installs this.
  const intoDefault = out.endsWith('providers.default.json');

  const key = catalog.apiKeyEnv ? process.env[catalog.apiKeyEnv] : undefined;
  if (catalog.apiKeyEnv && !key) {
    fail(`${catalog.apiKeyEnv} is not set — sync reads ${catalog.url}, which needs it.`);
  }

  const res = await fetch(catalog.url, {
    headers: key ? { authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) fail(`${catalog.url} returned ${res.status}`);
  const fetched = catalog.read(await res.json());
  console.log(`${catalog.id}: ${fetched.length} model(s) in the catalog`);
  console.log(`note: ${catalog.caveat}`);

  let file: RegistryFile;
  try {
    file = validateRegistryFile(JSON.parse(await readFile(out, 'utf8')) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    file = { providers: [] };
  }

  let provider = file.providers.find((p) => p.id === catalog.id);
  const createdProvider = !provider;
  if (!provider) {
    provider = {
      id: catalog.id,
      kind: 'openai-compat',
      baseUrl: catalog.url.replace(/\/models$/, ''),
      apiKeyEnv: catalog.providerApiKeyEnv ?? catalog.apiKeyEnv ?? '',
      // The lowest tier, deliberately. Generating `internal` would be sync
      // deciding what a provider may be trusted with — the one judgement this
      // whole file refuses to make on an existing entry, made silently on a
      // new one. Raising it is a human's call against evidence they checked.
      maxPrivacy: 'public',
      models: [],
    };
    file.providers.push(provider);
  }

  // Today, in UTC, so a run at 23:00 in one timezone stamps the same date as
  // the identical run somewhere else.
  const today = new Date().toISOString().slice(0, 10);
  const { models, changes, warnings, hazards } = syncModels(provider.models, fetched, today);

  const paid = models.filter((m) => !m.disabled && (m.price.inPerMTok !== 0 || m.price.outPerMTok !== 0));
  if (intoDefault && paid.length > 0) {
    fail(
      `refusing to write ${paid.length} paid model(s) into providers.default.json.\n` +
        `  The shipped registry is free tiers only. Use --out=providers.local.json.`,
    );
  }

  if (changes.length === 0) console.log('\nno changes.');
  else {
    console.log(`\n${changes.length} change(s):`);
    for (const c of changes) console.log(`  ${c.kind.padEnd(18)} ${c.id.padEnd(42)} ${c.detail}`);
  }
  if (warnings.length) {
    console.log(`\n${warnings.length} warning(s):`);
    for (const w of warnings) console.log(`  - ${w}`);
  }
  if (hazards.length) {
    console.error(`\n${hazards.length} hazard(s):`);
    for (const h of hazards) console.error(`  ! ${h}`);
  }

  const unrated = models.filter((m) => m.quality === undefined && !m.disabled).length;
  if (unrated) {
    console.log(
      `\n${unrated} model(s) are unrated. Routing scores them neutrally; rate the ones ` +
        `you care about by hand to make 'best' mean anything.`,
    );
  }

  provider.models = models;
  if (dryRun) {
    console.log(`\ndry run — ${out} not written.`);
    return hazards.length > 0 ? 3 : 0;
  }
  await writeFile(out, `${JSON.stringify(file, null, 2)}\n`);
  console.log(`\nwrote ${out}`);
  if (createdProvider) {
    console.log(
      `note: provider '${catalog.id}' was created at maxPrivacy 'public', the lowest tier. ` +
        'Raise it yourself once you know what the provider does with your text.',
    );
  }
  // Non-zero on a hazard so a scheduled sync fails instead of scrolling past
  // the one line that says confidential text is going somewhere it should not.
  return hazards.length > 0 ? 3 : 0;
}

async function run(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  // `process.exitCode`, never `process.exit()`.
  //
  // process.exit() terminates before pending stdout writes are flushed, and
  // writes to a pipe are asynchronous — so `probe --json | jq` would silently
  // lose the tail of its own output. Setting the code and letting the process
  // end naturally flushes first. This cost an afternoon once; leave it alone.
  switch (cmd) {
    case 'probe': {
      const lang = argv.find((a) => a.startsWith('--language='))?.split('=')[1];
      process.exitCode = lang ? await cmdProbeLanguage(lang, argv) : await cmdProbe(argv);
      break;
    }
    case 'route':
      process.exitCode = await cmdRoute(argv);
      break;
    case 'setup': {
      const cfg = configFromEnv();
      const envPath = argv.find((a) => !a.startsWith('-')) ?? resolve(process.cwd(), '.env');
      // Loaded the same way every other command loads it, so a build with no
      // registry file on disk falls back to the embedded one instead of
      // crashing on an empty path.
      process.exitCode = await runSetup(
        await loadRegistryFile(cfg.registryPath || null, cfg.registryPathExplicit),
        envPath,
      );
      break;
    }
    case 'sync':
      process.exitCode = await cmdSync(argv);
      break;
    case 'serve':
      await serveMain();
      break;
    default:
      fail('usage: inferencemesh <setup|probe|route|sync|serve> [options]');
  }
}

// A mistyped argument is a user error, not a crash. Without this, `route
// nosuchprofile` printed a stack trace with the Node version underneath it
// while every other bad input got a single usable line.
void run().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  // A usage error is already phrased for a person; anything else is an
  // exception that escaped and reads better with a prefix than as a stack.
  console.error(err instanceof UsageError ? message : `error: ${message}`);
  process.exitCode = 2;
});
