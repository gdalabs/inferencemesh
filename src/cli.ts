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

  const results: Array<{ key: string; ok: boolean; ms: number; detail: string }> = [];
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
        ok: true,
        ms: Date.now() - t0,
        detail: typeof text === 'string' ? text.slice(0, 40).replace(/\s+/g, ' ') : '',
      });
    } catch (err) {
      const status = err instanceof ProviderError ? err.status : undefined;
      // A mesh-level failure wraps the provider status in its message already.
      results.push({
        key: c.key,
        ok: false,
        ms: Date.now() - t0,
        detail: `${status ?? ''} ${err instanceof Error ? err.message : String(err)}`.trim().slice(0, 160),
      });
    }
  }

  if (json) {
    console.log(JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  } else {
    for (const r of results) {
      console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.key.padEnd(48)} ${String(r.ms).padStart(6)}ms  ${r.detail}`);
    }
    const okCount = results.filter((r) => r.ok).length;
    console.log(`\n${okCount}/${results.length} candidates reachable`);
  }
  // Non-zero when anything is broken, so a scheduler can alert on it.
  return results.every((r) => r.ok) ? 0 : 1;
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
