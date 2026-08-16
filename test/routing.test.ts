import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { Registry } from '../src/registry.js';
import { Router } from '../src/router.js';
import { HealthTracker } from '../src/health.js';
import { validateRegistryFile } from '../src/config.js';
import { FIXTURE_ENV, fakeClock, fixtureProviders } from './helpers.js';

function registry(env: Record<string, string | undefined> = FIXTURE_ENV): Registry {
  return new Registry(fixtureProviders(), { env });
}

describe('registry loading', () => {
  test('drops a provider whose key is missing, and says so', () => {
    const r = new Registry(fixtureProviders(), { env: { ALPHA_KEY: 'k', PAID_KEY: 'k' } });
    assert.deepEqual(
      r.providers.map((p) => p.id),
      ['alpha', 'keyless', 'paid'],
      "'keyless' is present without a key because it declares apiKeyOptional",
    );
    assert.deepEqual(r.warnings, [{ providerId: 'beta', reason: 'missing env BETA_KEY' }]);
  });

  test('an empty environment keeps only the providers that need no key', () => {
    const r = new Registry(fixtureProviders(), { env: {} });
    assert.deepEqual(
      r.providers.map((p) => p.id),
      ['keyless'],
      'apiKeyOptional survives a completely unconfigured environment',
    );
    assert.equal(r.warnings.length, 3);
    assert.equal(r.apiKey('keyless'), '', 'empty string means "takes no credential"');
  });

  test('asking for a key the registry never loaded is an error, not an empty string', () => {
    const r = new Registry(fixtureProviders(), { env: {} });
    assert.throws(() => r.apiKey('alpha'), /no API key loaded/);
  });

  test('validation rejects deliberately broken registry files', () => {
    const cases: Array<[string, unknown]> = [
      ['not an object', 42],
      ['no providers array', { providers: {} }],
      ['unknown kind', { providers: [{ id: 'a', kind: 'grpc', baseUrl: 'x', apiKeyEnv: 'K', maxPrivacy: 'public', models: [{ id: 'm', capabilities: ['text'], contextWindow: 1, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }] }] }],
      ['duplicate provider id', { providers: [mkProvider('a'), mkProvider('a')] }],
      ['model without capabilities', { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: [], contextWindow: 1, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }] }] }],
      ['quality out of range', { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: ['text'], contextWindow: 1, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 1.5 }] }] }],
      ['negative context window', { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: ['text'], contextWindow: 0, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }] }] }],
      ['a paid model with no priceVerifiedAt', { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: ['text'], contextWindow: 100, price: { inPerMTok: 3, outPerMTok: 15 }, quality: 0.5 }] }] }],
      ['a paid model with a non-date priceVerifiedAt', { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: ['text'], contextWindow: 100, price: { inPerMTok: 3, outPerMTok: 15 }, quality: 0.5, priceVerifiedAt: 'recently' }] }] }],
    ];
    for (const [name, bad] of cases) {
      assert.throws(() => validateRegistryFile(bad), /registry:|not an object/, `should reject: ${name}`);
    }
  });

  test('a free model needs no priceVerifiedAt — 0 cannot go stale', () => {
    const ok = { providers: [{ ...mkProvider('a'), models: [{ id: 'm', capabilities: ['text'], contextWindow: 100, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 }] }] };
    assert.doesNotThrow(() => validateRegistryFile(ok));
  });

  test('validation passes the registry that ships with the package', async () => {
    const raw = JSON.parse(
      await (await import('node:fs/promises')).readFile(
        new URL('../../providers.default.json', import.meta.url),
        'utf8',
      ),
    );
    const file = validateRegistryFile(raw);
    assert.ok(file.providers.length >= 3);
  });
});

function mkProvider(id: string) {
  return {
    id,
    kind: 'openai-compat',
    baseUrl: 'https://x.test/v1',
    apiKeyEnv: 'K',
    maxPrivacy: 'public',
    models: [
      { id: 'm', capabilities: ['text'], contextWindow: 100, price: { inPerMTok: 0, outPerMTok: 0 }, quality: 0.5 },
    ],
  };
}

describe('router — hard filters', () => {
  test('privacy is a filter, not a preference', () => {
    const d = new Router(registry()).route({ mesh: 'best', privacy: 'highly_confidential' });
    assert.deepEqual(
      d.ranked.map((r) => r.candidate.key),
      ['paid/paid-pro'],
    );
    assert.ok(d.rejected.some((r) => r.key === 'alpha/alpha-free' && r.reason.includes('privacy')));
  });

  test('a model lacking the capability is excluded, not merely ranked lower', () => {
    const d = new Router(registry()).route({ mesh: 'best', capabilities: ['vision'] });
    assert.deepEqual(
      d.ranked.map((r) => r.candidate.key),
      ['beta/beta-free'],
    );
    assert.equal(d.rejected.filter((r) => r.reason.startsWith('capability')).length, 3);
  });

  test('minContext excludes small windows', () => {
    const d = new Router(registry()).route({ mesh: 'best', minContext: 300_000 });
    assert.deepEqual(
      d.ranked.map((r) => r.candidate.key),
      ['paid/paid-pro'],
    );
  });

  test("the 'free' profile excludes paid models entirely", () => {
    const d = new Router(registry()).route({ mesh: 'free' });
    assert.ok(!d.ranked.some((r) => r.candidate.key === 'paid/paid-pro'));
    assert.ok(d.rejected.some((r) => r.key === 'paid/paid-pro' && r.reason.includes('not free')));
  });

  test('an unknown profile is an error, not a silent default', () => {
    assert.throws(() => new Router(registry()).route({ mesh: 'nope' }), /unknown mesh profile/);
  });

  test("a pin overrides the profile's price limit, but not privacy", () => {
    const router = new Router(registry());
    // 'free' is the default profile; pinning a paid model must still work.
    const pinned = router.route({ mesh: 'free', pin: 'paid/paid-pro' });
    assert.deepEqual(
      pinned.ranked.map((r) => r.candidate.key),
      ['paid/paid-pro'],
    );
    // ...but a pin cannot smuggle confidential text into a lower-tier provider.
    const unsafe = router.route({ pin: 'alpha/alpha-free', privacy: 'confidential' });
    assert.equal(unsafe.ranked.length, 0);
    assert.ok(unsafe.rejected.some((r) => r.reason.includes('privacy')));
  });

  test('a pin that names nothing yields no candidates and says why', () => {
    const d = new Router(registry()).route({ pin: 'ghost/model' });
    assert.equal(d.ranked.length, 0);
    assert.ok(d.rejected.some((r) => r.reason.includes('no such provider/model')));
  });
});

describe('router — language routing', () => {
  test('the same profile picks a different model per language', () => {
    const router = new Router(registry());
    // alpha and beta have identical quality and price; only the language term differs.
    const en = router.route({ mesh: 'free', language: 'en' }).ranked[0]?.candidate.key;
    const ja = router.route({ mesh: 'free', language: 'ja' }).ranked[0]?.candidate.key;
    assert.equal(en, 'alpha/alpha-free');
    assert.equal(ja, 'beta/beta-free');
  });

  test('a regional tag falls back to its base language', () => {
    const ranked = new Router(registry()).route({ mesh: 'free', language: 'ja-JP' }).ranked;
    assert.equal(ranked[0]?.candidate.key, 'beta/beta-free');
  });

  test('an unlisted language uses the default score, not zero', () => {
    const ranked = new Router(registry()).route({ mesh: 'free', language: 'sw' }).ranked;
    for (const r of ranked) assert.ok((r.terms['language'] ?? 0) > 0);
  });
});

describe('router — health', () => {
  test('an open breaker removes a candidate', () => {
    const clock = fakeClock();
    const health = new HealthTracker({ failureThreshold: 1 }, clock.now);
    health.failure('alpha/alpha-free');
    const d = new Router(registry(), { health }).route({ mesh: 'free', language: 'en' });
    assert.equal(d.ranked[0]?.candidate.key, 'beta/beta-free');
    assert.ok(d.rejected.some((r) => r.key === 'alpha/alpha-free' && r.reason.startsWith('health')));
  });

  test('when every breaker is open, health is ignored rather than answering nothing', () => {
    const clock = fakeClock();
    const health = new HealthTracker({ failureThreshold: 1 }, clock.now);
    for (const k of ['alpha/alpha-free', 'beta/beta-free', 'keyless/open-tier']) health.failure(k);
    const d = new Router(registry(), { health }).route({ mesh: 'free' });
    assert.equal(d.ranked.length, 3, 'a probably-down provider still beats no provider');
  });

  test('a closed breaker restores the candidate after the cooldown', () => {
    const clock = fakeClock();
    const health = new HealthTracker({ failureThreshold: 1, cooldownMs: 1000 }, clock.now);
    health.failure('alpha/alpha-free');
    assert.equal(health.isOpen('alpha/alpha-free'), true);
    clock.advance(1001);
    assert.equal(health.isOpen('alpha/alpha-free'), false);
  });
});

describe('router — determinism', () => {
  test('identical scores break ties by key, not by registry order', () => {
    const forward = new Router(new Registry(fixtureProviders(), { env: FIXTURE_ENV })).route({ mesh: 'free' });
    const reversed = new Router(new Registry(fixtureProviders().reverse(), { env: FIXTURE_ENV })).route({ mesh: 'free' });
    assert.deepEqual(
      forward.ranked.map((r) => r.candidate.key),
      reversed.ranked.map((r) => r.candidate.key),
    );
  });
});
