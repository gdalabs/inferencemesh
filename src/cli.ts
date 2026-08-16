#!/usr/bin/env node
/**
 * CLI.
 *
 *   inferencemesh probe            call every candidate once and report what works
 *   inferencemesh route <profile>  explain a routing decision without any network
 *   inferencemesh serve            start the Node gateway
 *
 * `probe` exists because a registry file rots silently. Model ids get retired,
 * free tiers get withdrawn, and a key gets revoked — none of which produce an
 * error until a user is waiting on a reply. Probing turns all of that into an
 * exit code you can put on a schedule.
 */

import { readFile } from 'node:fs/promises';

import { registryFrom } from './config.js';
import { InferenceMesh } from './mesh.js';
import { Router } from './router.js';
import { blendedPrice, maxPrivacyOf } from './registry.js';
import { configFromEnv, main as serveMain } from './server/node.js';
import { ProviderError } from './providers/base.js';
import type { Capability, PrivacyLevel } from './types.js';

function fail(msg: string): never {
  console.error(msg);
  process.exit(2);
}

async function loadRegistry() {
  const cfg = configFromEnv();
  const raw = JSON.parse(await readFile(cfg.registryPath, 'utf8')) as unknown;
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
        `q=${(t['quality'] ?? 0).toFixed(2)} cost=${(t['cost'] ?? 0).toFixed(2)} ` +
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

async function run(): Promise<void> {
  const [cmd, ...argv] = process.argv.slice(2);
  switch (cmd) {
    case 'probe':
      process.exit(await cmdProbe(argv));
      break;
    case 'route':
      process.exit(await cmdRoute(argv));
      break;
    case 'serve':
      await serveMain();
      break;
    default:
      fail('usage: inferencemesh <probe|route|serve> [options]');
  }
}

void run();
