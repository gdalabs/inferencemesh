import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { NOUS, OPENROUTER, REDPILL } from '../src/catalogs.js';
import { validateRegistryFile } from '../src/config.js';
import { DEFAULT_QUALITY_SCORE, qualityScore } from '../src/registry.js';
import { mergeCapabilities, syncModels, type CatalogModel } from '../src/sync.js';
import type { ModelEntry } from '../src/types.js';

const TODAY = '2026-08-21';

function catalogModel(over: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: 'vendor/model',
    capabilities: ['text'],
    undeclared: false,
    contextWindow: 8000,
    price: { inPerMTok: 1, outPerMTok: 2 },
    ...over,
  };
}

function entry(over: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: 'vendor/model',
    capabilities: ['text'],
    contextWindow: 8000,
    price: { inPerMTok: 1, outPerMTok: 2 },
    priceVerifiedAt: '2026-01-01',
    ...over,
  };
}

describe('sync — what a catalog may write', () => {
  test('a new model is added unrated, not guessed', () => {
    // The whole point. A catalog knows the price and nothing about how good
    // the model is; writing a plausible 0.7 would reorder `best` on a number
    // nobody measured.
    const r = syncModels([], [catalogModel()], TODAY);
    const m = r.models[0] as ModelEntry;
    assert.equal(m.quality, undefined);
    assert.equal(m.languages, undefined);
    assert.equal(r.changes[0]?.kind, 'added');
  });

  test('a paid price is stamped with the day it was read', () => {
    const r = syncModels([], [catalogModel()], TODAY);
    assert.equal((r.models[0] as ModelEntry).priceVerifiedAt, TODAY);
  });

  test('a free price carries no stamp, because 0 cannot go stale', () => {
    const r = syncModels([], [catalogModel({ price: { inPerMTok: 0, outPerMTok: 0 } })], TODAY);
    assert.equal((r.models[0] as ModelEntry).priceVerifiedAt, undefined);
  });

  test('human judgement survives a sync', () => {
    const prior = entry({
      quality: 0.72,
      languages: { ja: 0.85 },
      quota: { requestsPerMinute: 5 },
    });
    const r = syncModels([prior], [catalogModel()], TODAY);
    const m = r.models[0] as ModelEntry;
    assert.equal(m.quality, 0.72);
    assert.deepEqual(m.languages, { ja: 0.85 });
    assert.deepEqual(m.quota, { requestsPerMinute: 5 });
  });

  test('a price change is applied and reported', () => {
    const r = syncModels(
      [entry()],
      [catalogModel({ price: { inPerMTok: 3, outPerMTok: 9 } })],
      TODAY,
    );
    assert.equal(r.changes[0]?.kind, 'repriced');
    assert.match(r.changes[0]?.detail as string, /\$1\/\$2 per MTok -> \$3\/\$9 per MTok/);
    assert.deepEqual((r.models[0] as ModelEntry).price, { inPerMTok: 3, outPerMTok: 9 });
  });

  test('an unchanged catalog produces no changes at all', () => {
    // Churn is the failure mode that kills a scheduled sync: if every run
    // reports something, nobody reads the run that reports the real thing.
    const first = syncModels([], [catalogModel()], TODAY);
    const second = syncModels(first.models, [catalogModel()], TODAY);
    assert.deepEqual(second.changes, []);
    assert.deepEqual(second.models, first.models);
  });
});

describe('sync — what a catalog may not erase', () => {
  test('a silent catalog does not overwrite probed capabilities', () => {
    // `undeclared` means the catalog said nothing, which is not the same as
    // saying "no tools". RedPill ships 14 such models and at least one of them
    // answers fine.
    const prior = entry({ capabilities: ['text', 'tools', 'json'] });
    const r = syncModels([prior], [catalogModel({ capabilities: ['text'], undeclared: true })], TODAY);
    assert.deepEqual((r.models[0] as ModelEntry).capabilities, ['text', 'tools', 'json']);
    assert.equal(r.changes.length, 0);
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0] as string, /absent is not denied/);
  });

  test('a declaring catalog does overwrite them, and says so', () => {
    const prior = entry({ capabilities: ['text'] });
    const r = syncModels([prior], [catalogModel({ capabilities: ['text', 'vision'] })], TODAY);
    assert.deepEqual((r.models[0] as ModelEntry).capabilities, ['text', 'vision']);
    assert.equal(r.changes[0]?.kind, 'capabilities');
  });

  test('a model that leaves the catalog is disabled, not deleted', () => {
    const prior = entry({ id: 'vendor/retired', quality: 0.9 });
    const r = syncModels([prior], [], TODAY);
    const m = r.models[0] as ModelEntry;
    assert.equal(m.disabled, true);
    assert.equal(m.quality, 0.9, 'deleting would throw away the rating');
    assert.equal(r.changes[0]?.kind, 'vanished');
  });

  test('a disabled model that returns is reported, never re-enabled', () => {
    // Re-enabling would undo a deliberate "I do not want this one".
    const r = syncModels([entry({ disabled: true })], [catalogModel()], TODAY);
    assert.equal((r.models[0] as ModelEntry).disabled, true);
    assert.equal(r.changes[0]?.kind, 'returned');
  });

  test('a vanished model already disabled does not re-report every run', () => {
    const r = syncModels([entry({ disabled: true })], [], TODAY);
    assert.deepEqual(r.changes, []);
  });
});

describe('sync — privacy is the human half', () => {
  const tee = catalogModel({ maxPrivacy: 'internal', note: 'TEE claimed by the vendor' });

  test('a new entry takes the catalog tier, and records it as evidence', () => {
    const m = syncModels([], [tee], TODAY).models[0] as ModelEntry;
    assert.equal(m.maxPrivacy, 'internal');
    assert.equal(m.evidencePrivacy, 'internal');
  });

  test('a tier a human raised is never overwritten', () => {
    // The bug this pins: comparing the catalog against maxPrivacy cannot tell
    // "a human raised it" from "the vendor downgraded it", and lowering it
    // silently erased a decision the design says is the human's to make.
    const prior = entry({ maxPrivacy: 'confidential', evidencePrivacy: 'internal' });
    const m = syncModels([prior], [tee], TODAY).models[0] as ModelEntry;
    assert.equal(m.maxPrivacy, 'confidential');
  });

  test('a tier above the evidence with nobody signing off is a hazard', () => {
    const prior = entry({ maxPrivacy: 'confidential', evidencePrivacy: 'internal' });
    const r = syncModels([prior], [tee], TODAY);
    assert.equal(r.hazards.length, 1);
    assert.match(r.hazards[0] as string, /nothing records who checked/);
  });

  test('a dated sign-off keeps the run quiet while the evidence holds', () => {
    const prior = entry({
      maxPrivacy: 'confidential',
      evidencePrivacy: 'internal',
      privacyVerifiedAt: '2026-08-21',
    });
    const r = syncModels([prior], [tee], TODAY);
    assert.deepEqual(r.hazards, []);
    assert.match(r.warnings[0] as string, /on a check dated 2026-08-21/);
  });

  test('evidence moving makes an old sign-off stale again', () => {
    // A vendor dropping the TEE claim is exactly when a year-old attestation
    // stops meaning anything.
    const prior = entry({
      maxPrivacy: 'confidential',
      evidencePrivacy: 'confidential',
      privacyVerifiedAt: '2026-01-01',
    });
    const r = syncModels([prior], [tee], TODAY);
    assert.equal(r.hazards.length, 1);
    assert.match(r.hazards[0] as string, /that support just changed/);
    assert.equal(r.changes[0]?.kind, 'privacy-evidence');
  });

  test('a tier at or below the evidence is nobody-s business', () => {
    const prior = entry({ maxPrivacy: 'public', evidencePrivacy: 'internal' });
    const r = syncModels([prior], [tee], TODAY);
    assert.deepEqual(r.hazards, []);
  });
});

describe('catalog reader — redpill', () => {
  const raw = (over: Record<string, unknown> = {}) => ({
    data: [
      {
        id: 'phala/thing',
        name: 'Phala: Thing',
        context_length: 131072,
        is_tee: true,
        providers: ['phala'],
        pricing: { prompt: '0.0000003', completion: '0.0000015' },
        input_modalities: ['text', 'image'],
        supported_parameters: ['tools', 'structured_outputs'],
        ...over,
      },
    ],
  });

  test('per-token becomes per-million with no float dust', () => {
    // 0.0000002 * 1e6 is 0.19999999999999998. Left alone it diffs against a
    // hand-written 0.2 forever and reports a price change that never happened.
    const m = REDPILL.read(raw({ pricing: { prompt: '0.0000002', completion: '0.0000004' } }))[0];
    assert.equal(m?.price.inPerMTok, 0.2);
    assert.equal(m?.price.outPerMTok, 0.4);
  });

  test('the published price is reproduced exactly', () => {
    // Cross-checked against redpill.ai/pricing on 2026-08-21: $0.30 / $1.50.
    const m = REDPILL.read(raw())[0];
    assert.equal(m?.price.inPerMTok, 0.3);
    assert.equal(m?.price.outPerMTok, 1.5);
  });

  test('capabilities come from modalities and parameters', () => {
    const m = REDPILL.read(raw())[0];
    assert.deepEqual(m?.capabilities, ['text', 'vision', 'tools', 'json']);
  });

  test('`code` is never derived, because no field describes it', () => {
    const m = REDPILL.read(raw())[0];
    assert.equal(m?.capabilities.includes('code'), false);
  });

  test('an empty parameter list reads as undeclared, not as incapable', () => {
    const m = REDPILL.read(raw({ supported_parameters: [], supported_features: [] }))[0];
    assert.equal(m?.undeclared, true);
    assert.deepEqual(m?.capabilities, ['text', 'vision']);
  });

  test('a TEE flag earns `internal`, never `confidential`', () => {
    const m = REDPILL.read(raw())[0];
    assert.equal(m?.maxPrivacy, 'internal');
    assert.match(m?.note as string, /operator\(s\): phala/);
  });

  test('a relay is `public`, and the note says whose it is', () => {
    const m = REDPILL.read(raw({ is_tee: false, providers: ['anthropic'] }))[0];
    assert.equal(m?.maxPrivacy, 'public');
    assert.match(m?.note as string, /relay to anthropic/);
  });

  test('an unreadable price is refused rather than defaulted to free', () => {
    // Silently reading a broken price as 0 would put a paid model at the top
    // of the `cheap` profile and skip the priceVerifiedAt requirement.
    assert.throws(() => REDPILL.read(raw({ pricing: { prompt: null } })), /unreadable price/);
    assert.throws(() => REDPILL.read(raw({ context_length: 0 })), /unreadable context_length/);
  });

  test('a response with no data array is an error, not an empty catalog', () => {
    // An empty catalog would disable every model in the file.
    assert.throws(() => REDPILL.read({ error: 'nope' }), /no `data` array/);
  });
});

describe('registry — unrated models', () => {
  test('an absent quality scores neutrally, not optimistically', () => {
    // Optimism is repaid for latency because one request measures it. Nothing
    // measures quality, so an optimistic default would park every unrated
    // model above every rated one for good.
    assert.equal(qualityScore({ ...entry(), quality: undefined }), DEFAULT_QUALITY_SCORE);
    assert.equal(qualityScore({ ...entry(), quality: 0.9 }), 0.9);
    assert.ok(DEFAULT_QUALITY_SCORE < 1);
  });

  test('validation accepts an absent quality and still rejects a broken one', () => {
    const file = (q: unknown) => ({
      providers: [
        {
          id: 'p',
          kind: 'openai-compat',
          baseUrl: 'https://x/v1',
          apiKeyEnv: 'K',
          maxPrivacy: 'internal',
          models: [
            {
              id: 'm',
              capabilities: ['text'],
              contextWindow: 100,
              price: { inPerMTok: 0, outPerMTok: 0 },
              ...(q === 'omit' ? {} : { quality: q }),
            },
          ],
        },
      ],
    });
    assert.doesNotThrow(() => validateRegistryFile(file('omit')));
    assert.doesNotThrow(() => validateRegistryFile(file(0.5)));
    assert.throws(() => validateRegistryFile(file(null)), /within 0\.\.1/);
    assert.throws(() => validateRegistryFile(file('0.8')), /within 0\.\.1/);
    assert.throws(() => validateRegistryFile(file(2)), /within 0\.\.1/);
  });
});

describe('sync — capabilities a catalog cannot see', () => {
  test('a hand-recorded `code` survives a catalog that never mentions code', () => {
    // Found by running the OpenRouter sync against the shipped registry:
    // `code,json,text -> text,tools` would have deleted a human's rating of a
    // model that had not changed, and mesh/coding would stop seeing it.
    const prior = entry({ capabilities: ['code', 'json', 'text'] });
    const r = syncModels([prior], [catalogModel({ capabilities: ['text', 'tools'] })], TODAY);
    const caps = (r.models[0] as ModelEntry).capabilities;
    assert.ok(caps.includes('code'), 'code is not a thing any catalog declares');
    assert.ok(caps.includes('tools'), "the catalog's own answer still lands");
  });

  test('a capability the catalog does own is allowed to go away', () => {
    // `json` is expressible — a declared parameter list that omits it is an
    // answer, not a silence — so the catalog gets to remove it.
    const prior = entry({ capabilities: ['json', 'text'] });
    const r = syncModels([prior], [catalogModel({ capabilities: ['text'] })], TODAY);
    assert.deepEqual((r.models[0] as ModelEntry).capabilities, ['text']);
  });

  test('an undeclared catalog still erases nothing', () => {
    const prior = entry({ capabilities: ['code', 'json', 'text', 'vision'] });
    const r = syncModels([prior], [catalogModel({ capabilities: ['text'], undeclared: true })], TODAY);
    assert.deepEqual((r.models[0] as ModelEntry).capabilities, ['code', 'json', 'text', 'vision']);
  });

  test('mergeCapabilities keeps only what the catalog cannot describe', () => {
    assert.deepEqual(mergeCapabilities(['code', 'ocr', 'json'], ['text', 'tools']).sort(), [
      'code',
      'ocr',
      'text',
      'tools',
    ]);
  });
});

describe('sync — an announced end date', () => {
  test('a new expiry is recorded and reported', () => {
    const r = syncModels([entry()], [catalogModel({ expiresAt: '2026-08-24' })], TODAY);
    assert.equal((r.models[0] as ModelEntry).expiresAt, '2026-08-24');
    assert.equal(r.changes.find((c) => c.kind === 'expiry')?.detail.includes('2026-08-24'), true);
  });

  test('withdrawing the announcement is news too, and clears the field', () => {
    const r = syncModels([entry({ expiresAt: '2026-08-24' })], [catalogModel()], TODAY);
    assert.equal((r.models[0] as ModelEntry).expiresAt, undefined);
    assert.match(r.changes.find((c) => c.kind === 'expiry')?.detail ?? '', /no longer announced/);
  });

  test('an expiry close enough to act on is warned about', () => {
    const r = syncModels([], [catalogModel({ expiresAt: '2026-08-24' })], TODAY);
    assert.equal(r.warnings.filter((w) => w.includes('2026-08-24')).length, 1);
  });

  test("a far-future sentinel is recorded but not announced", () => {
    // OpenRouter writes 2098-12-31 for "no expiry". Warning about those every
    // run buries the one that is two days away.
    const r = syncModels([], [catalogModel({ expiresAt: '2098-12-31' })], TODAY);
    assert.equal((r.models[0] as ModelEntry).expiresAt, '2098-12-31');
    assert.deepEqual(r.warnings.filter((w) => w.includes('2098')), []);
  });

  test('a date that has already passed is worth saying out loud', () => {
    const r = syncModels([], [catalogModel({ expiresAt: '2026-08-01' })], TODAY);
    assert.match(r.warnings.find((w) => w.includes('2026-08-01')) ?? '', /has passed/);
  });

  test('an unparseable date is not guessed at', () => {
    const r = syncModels([], [catalogModel({ expiresAt: 'soon' })], TODAY);
    assert.deepEqual(r.warnings.filter((w) => w.includes('soon')), []);
  });
});

describe('OPENROUTER catalog reader', () => {
  const model = (over: Record<string, unknown> = {}) => ({
    id: 'vendor/thing:free',
    name: 'Thing',
    context_length: 128000,
    architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools', 'response_format'],
    ...over,
  });
  const raw = (...models: Array<Record<string, unknown>>) => ({ data: models });

  test('a free model is read with the capabilities the catalog declares', () => {
    const [m] = OPENROUTER.read(raw(model()));
    assert.equal(m?.id, 'vendor/thing:free');
    assert.deepEqual(m?.capabilities.sort(), ['json', 'text', 'tools', 'vision']);
    assert.deepEqual(m?.price, { inPerMTok: 0, outPerMTok: 0 });
  });

  test('a paid model is skipped', () => {
    assert.deepEqual(OPENROUTER.read(raw(model({ pricing: { prompt: '0.0000002', completion: '0' } }))), []);
  });

  test('a zero-per-token model that charges another way is not free', () => {
    // web_search, image, audio, the cache keys: any of them.
    const paid = model({ pricing: { prompt: '0', completion: '0', web_search: '0.004' } });
    assert.deepEqual(OPENROUTER.read(raw(paid)), []);
  });

  test('a time-of-day override window that charges is not free either', () => {
    // The one that would actually catch someone: free at the top level, priced
    // inside a window. utc_start/utc_end are hours and must not be read as money.
    const tricky = model({
      pricing: {
        prompt: '0',
        completion: '0',
        overrides: [
          { utc_start: 0, utc_end: 600, prompt: '0', completion: '0' },
          { utc_start: 600, utc_end: 2400, prompt: '0.0000004', completion: '0.0000008' },
        ],
      },
    });
    assert.deepEqual(OPENROUTER.read(raw(tricky)), []);
  });

  test('an all-zero override window stays free, and the hours are not prices', () => {
    const free = model({
      pricing: {
        prompt: '0',
        completion: '0',
        overrides: [{ utc_start: 100, utc_end: 2300, prompt: '0', completion: '0' }],
      },
    });
    assert.equal(OPENROUTER.read(raw(free)).length, 1);
  });

  test('a model that does not answer in text is not a chat candidate', () => {
    const audio = model({ architecture: { output_modalities: ['audio'] } });
    assert.deepEqual(OPENROUTER.read(raw(audio)), []);
  });

  test('a generator that also emits text is not a chat candidate', () => {
    // google/lyria-3-clip-preview on 2026-09-05: zero per token, text among
    // its outputs, and 0.04 charged for the clip it actually produces.
    const clip = model({ architecture: { output_modalities: ['text', 'audio'] } });
    assert.deepEqual(OPENROUTER.read(raw(clip)), []);
  });

  test('an unstated output list is not a denial', () => {
    // Absent is not denied: older entries and other catalogs omit the list,
    // and dropping them would lose live chat models to say nothing new.
    const absent = model({ architecture: { input_modalities: ['text'] } });
    assert.equal(OPENROUTER.read(raw(absent)).length, 1);
    const empty = model({ architecture: { output_modalities: [] } });
    assert.equal(OPENROUTER.read(raw(empty)).length, 1);
  });

  test('an announced expiry is carried through', () => {
    const [m] = OPENROUTER.read(raw(model({ expiration_date: '2026-08-24' })));
    assert.equal(m?.expiresAt, '2026-08-24');
  });

  test('no privacy evidence is invented — the upstream is chosen per request', () => {
    const [m] = OPENROUTER.read(raw(model()));
    assert.equal(m?.maxPrivacy, undefined);
  });

  test('an empty parameter list is not read as "no tools"', () => {
    const [m] = OPENROUTER.read(raw(model({ supported_parameters: [] })));
    assert.deepEqual(m?.capabilities.sort(), ['text', 'vision'], 'modalities still count');
    assert.ok(!m?.capabilities.includes('tools'), 'and nothing is invented');
  });

  test('a catalog entry that declares nothing at all is undeclared', () => {
    // Both halves have to be silent. A modality list is a declaration, and
    // calling that "undeclared" makes sync warn about a silence that did not
    // happen — while a truly empty entry must still not be read as "no tools".
    const [m] = OPENROUTER.read(
      raw(model({ supported_parameters: [], architecture: { output_modalities: ['text'] } })),
    );
    assert.equal(m?.undeclared, true);
    assert.deepEqual(m?.capabilities, ['text']);
  });

  test('an unreadable price throws rather than defaulting to free', () => {
    assert.throws(
      () => OPENROUTER.read(raw(model({ pricing: { prompt: 'free', completion: '0' } }))),
      /unreadable prompt price/,
    );
    assert.throws(
      () => OPENROUTER.read(raw(model({ pricing: { prompt: '0', completion: '0', overrides: 'nope' } }))),
      /unreadable overrides/,
    );
    assert.throws(() => OPENROUTER.read({ data: 'nope' }), /no `data` array/);
  });
});

describe('OpenRouter anonymous previews', () => {
  const stealth = (over: Record<string, unknown> = {}) => ({
    data: [
      {
        id: 'stealth/ox-alpha',
        name: 'Ox Alpha',
        context_length: 1048576,
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0' },
        supported_parameters: ['tools'],
        expiration_date: '2098-12-31',
        ...over,
      },
    ],
  });

  test('a stealth listing is marked temporary, whatever its expiry says', () => {
    // The trap this exists for: on 2026-08-25 the listing carried
    // 2098-12-31 — the sentinel for "no end announced" — on a format that
    // lasts a week or two. The expiry warning can never fire for it.
    const [m] = OPENROUTER.read(stealth());
    assert.equal(m?.ephemeral, true);
    assert.equal(m?.expiresAt, '2098-12-31', 'and the sentinel is still recorded as read');
  });

  test('its privacy tier is the floor, on evidence rather than by default', () => {
    // The operator is anonymous and retains the prompts. That is the same
    // answer as a keyless endpoint: public, and not a human's decision to make
    // upward without knowing who is on the other end.
    const [m] = OPENROUTER.read(stealth());
    assert.equal(m?.maxPrivacy, 'public');
    assert.match(m?.note ?? '', /anonymous|retained/);
  });

  test('an ordinary free model is not marked temporary', () => {
    const [m] = OPENROUTER.read({
      data: [
        {
          id: 'google/gemma-4-31b-it:free',
          context_length: 262144,
          architecture: { output_modalities: ['text'] },
          pricing: { prompt: '0', completion: '0' },
          supported_parameters: ['tools'],
        },
      ],
    });
    assert.equal(m?.ephemeral, undefined);
    assert.equal(m?.maxPrivacy, undefined, 'the file decides, as before');
  });

  test('sync warns about a temporary listing on every run', () => {
    const r = syncModels([], [catalogModel({ id: 'stealth/x', ephemeral: true })], TODAY);
    assert.equal(r.warnings.filter((w) => w.includes('temporary listing')).length, 1);
  });
});

describe('pricing conditions are not prices', () => {
  const withOverride = (window: Record<string, unknown>) => ({
    data: [
      {
        id: 'vendor/m:free',
        context_length: 1000,
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0', completion: '0', overrides: [window] },
        supported_parameters: [],
      },
    ],
  });

  test('a weekday scope does not make a model unreadable', () => {
    // `utc_days` arrived between 2026-08-22 and 2026-08-25 and threw, because
    // everything that was not an hour was assumed to be money.
    const out = OPENROUTER.read(withOverride({ utc_days: ['saturday'], prompt: '0', completion: '0' }));
    assert.equal(out.length, 1);
  });

  test('a token threshold is not read as a price', () => {
    // `min_prompt_tokens: 64` is a condition and a number. Read as money it
    // marks a free model paid, and the model silently stops being offered.
    const out = OPENROUTER.read(withOverride({ min_prompt_tokens: 64, prompt: '0', completion: '0' }));
    assert.equal(out.length, 1, 'still free');
  });

  test('an unknown key that is a number is still treated as money', () => {
    // The list is of conditions, not of prices, so a price key nobody has seen
    // yet counts against free rather than being skipped.
    assert.deepEqual(OPENROUTER.read(withOverride({ video: '0.004', prompt: '0', completion: '0' })), []);
  });

  test('an unknown key that is not a number is an error, not an assumption', () => {
    assert.throws(
      () => OPENROUTER.read(withOverride({ mystery: { nested: true }, prompt: '0' })),
      /unreadable mystery/,
    );
  });
});

describe('a list price is not a charge', () => {
  const withPricing = (pricing: Record<string, unknown>) => ({
    data: [
      {
        id: 'vendor/m:free',
        context_length: 1000,
        architecture: { output_modalities: ['text'] },
        pricing,
        supported_parameters: [],
      },
    ],
  });

  test('a non-zero original does not make a currently free model paid', () => {
    // Nous carries `original` — the undiscounted list price — on 362 of 371
    // models. Read as money it would drop every discounted-to-zero model.
    const out = NOUS.read(
      withPricing({
        prompt: '0',
        completion: '0',
        original: { prompt: '0.00000015', completion: '0.00000047' },
      }),
    );
    assert.equal(out.length, 1, 'zero today is free today');
  });

  test('a zero original is still validated rather than trusted', () => {
    const out = NOUS.read(
      withPricing({ prompt: '0', completion: '0', original: { prompt: '0', completion: 0 } }),
    );
    assert.equal(out.length, 1);
  });

  test('an original that is not an object is an error', () => {
    assert.throws(
      () => NOUS.read(withPricing({ prompt: '0', completion: '0', original: '0' })),
      /nous: vendor\/m:free has an unreadable original price/,
    );
  });

  test('an unreadable price inside original is an error, not an assumption', () => {
    assert.throws(
      () => NOUS.read(withPricing({ prompt: '0', completion: '0', original: { prompt: 'free' } })),
      /nous: vendor\/m:free has an unreadable original\.prompt price/,
    );
  });

  test('an all-day override still costs money even under a zero headline', () => {
    // tencent/hy3:free on 2026-08-28 — the first zero-priced model to carry
    // overrides, which is the case the check was written for.
    const out = NOUS.read(
      withPricing({
        prompt: '0',
        completion: '0',
        overrides: [
          { utc_start: 0, utc_end: 1600, prompt: '0.000000132', completion: '0.000000528' },
          { utc_start: 1600, utc_end: 0, prompt: '0.0000000825', completion: '0.00000033' },
        ],
      }),
    );
    assert.deepEqual(out, [], 'free-looking, not free');
  });
});
