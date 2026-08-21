#!/usr/bin/env node
/**
 * CLI.
 *
 *   inferencemesh setup            walk through getting keys, verifying each one
 *   inferencemesh probe            call every candidate once and report what works
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
import { registryFrom, validateRegistryFile, type RegistryFile } from './config.js';
import { InferenceMesh } from './mesh.js';
import { Router } from './router.js';
import { blendedPrice, maxPrivacyOf } from './registry.js';
import { configFromEnv, loadRegistryFile, main as serveMain } from './server/node.js';
import { runSetup } from './setup.js';
import { syncModels } from './sync.js';
import { ProviderError } from './providers/base.js';
import type { Capability, PrivacyLevel } from './types.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

async function loadRegistry() {
  const cfg = configFromEnv();
  const raw = await loadRegistryFile(cfg.registryPath || null);
  const registry = registryFrom(raw);
  for (const w of registry.warnings) {
    console.warn(`warn: provider '${w.providerId}' skipped: ${w.reason}`);
  }
  return registry;
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
      const message = err instanceof Error ? err.message : String(err);
      // maxAttempts is 1, so the mesh error wraps exactly one provider status.
      const status =
        err instanceof ProviderError ? err.status : Number(message.match(/\((\d{3}):/)?.[1]) || undefined;
      results.push({
        key: c.key,
        verdict: status === 429 ? 'limited' : 'broken',
        ...(status ? { status } : {}),
        ms: Date.now() - t0,
        detail: message.replace(/^all 1 attempt\(s\) failed: \S+ /, '').slice(0, 160),
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
  }
  // Only rot sets the exit code. Being rate limited is the free tier working.
  return broken.length === 0 ? 0 : 1;
}

async function cmdRoute(argv: string[]): Promise<number> {
  const registry = await loadRegistry();
  const router = new Router(registry);
  const profile = argv[0] ?? registry.defaultProfile;
  const arg = (name: string) => argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
  const caps = arg('capabilities');

  const decision = router.route({
    mesh: profile,
    ...(arg('language') ? { language: arg('language') as string } : {}),
    ...(arg('privacy') ? { privacy: arg('privacy') as PrivacyLevel } : {}),
    ...(caps ? { capabilities: caps.split(',') as Capability[] } : {}),
    ...(arg('min-context') ? { minContext: Number(arg('min-context')) } : {}),
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
  if (!provider) {
    provider = {
      id: catalog.id,
      kind: 'openai-compat',
      baseUrl: catalog.url.replace(/\/models$/, ''),
      apiKeyEnv: catalog.apiKeyEnv ?? '',
      maxPrivacy: 'internal',
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
    case 'probe':
      process.exitCode = await cmdProbe(argv);
      break;
    case 'route':
      process.exitCode = await cmdRoute(argv);
      break;
    case 'setup': {
      const cfg = configFromEnv();
      const envPath = argv.find((a) => !a.startsWith('-')) ?? resolve(process.cwd(), '.env');
      process.exitCode = await runSetup(cfg.registryPath, envPath);
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

void run();
