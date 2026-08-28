/**
 * Provider catalogs: where to read a model list, and how to read it.
 *
 * Each entry is the minimum needed to turn one provider's `/v1/models` into
 * registry entries. The readers are pure functions over already-parsed JSON so
 * they can be tested against a captured response with no network and no key.
 */

import type { CatalogModel } from './sync.js';
import type { Capability, PrivacyLevel } from './types.js';

export interface CatalogSource {
  /** Registry provider id this catalog fills. */
  id: string;
  url: string;
  /** Env var holding the key, when the catalog needs one. */
  apiKeyEnv?: string;
  /**
   * Env var the *provider* needs to serve a request, when that is not the same
   * as the one the catalog needs. OpenRouter publishes its model list to
   * anybody and asks for a key only at inference time, so a generated provider
   * stanza that copied `apiKeyEnv` would come out with no credential at all.
   */
  providerApiKeyEnv?: string;
  /** Human-readable note about what this catalog does and does not carry. */
  caveat: string;
  read(raw: unknown): CatalogModel[];
}

/**
 * Per-token to per-million, without the float dust.
 *
 * `0.0000002 * 1e6` is 0.19999999999999998, not 0.2. Left alone, every run
 * would diff that against a hand-written 0.2 and report a price change that
 * never happened — an endless churn of "repriced" lines that trains you to
 * ignore the one real one. Six decimals is finer than the cheapest published
 * price ($0.005/MTok) by three orders of magnitude.
 */
function perMTok(perToken: number): number {
  return Number((perToken * 1e6).toFixed(6));
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

interface RedpillModel {
  id?: string;
  name?: string;
  context_length?: number;
  is_tee?: boolean;
  providers?: string[];
  pricing?: { prompt?: string; completion?: string };
  input_modalities?: string[];
  supported_parameters?: string[];
  supported_features?: string[];
}

/**
 * RedPill (Phala) — https://api.redpill.ai/v1/models
 *
 * The richest catalog found so far: it carries per-token prices, context
 * window, input modalities, accepted parameters, a `is_tee` flag and the list
 * of operators actually running each model.
 *
 * ## Why `is_tee: true` is not `confidential`
 *
 * Two separate reasons, and each on its own is enough.
 *
 * First, `is_tee` is the vendor asserting something about themselves in a JSON
 * field. Nothing here has checked an attestation, and a privacy tier is the one
 * filter routing will never override — earning it from an unverified boolean
 * would mean confidential text goes wherever a vendor says it may.
 *
 * Second, even where the flag is true, the operator is often not Phala:
 * `providers` also contains `chutes`, `near-ai`, `tinfoil` and `secretai`, and
 * a model listing several of them gives the caller no way to choose. "Runs in
 * *a* TEE, operated by *somebody*" is not a data-handling commitment.
 *
 * So TEE-hosted models are generated as `internal` and relays as `public`, and
 * raising one to `confidential` stays a human decision made against an
 * attestation. Measured 2026-08-21: 24 of 66 models had `is_tee: true`, and the
 * other 42 were straight relays to Anthropic, OpenAI, Google and xAI.
 */
export const REDPILL: CatalogSource = {
  id: 'redpill',
  url: 'https://api.redpill.ai/v1/models',
  apiKeyEnv: 'PHALA_API_KEY',
  caveat:
    'Prices are per-token and converted; TEE models are generated as `internal`, relays as `public`. ' +
    'Raise anything to `confidential` only against an attestation you checked yourself.',
  read(raw: unknown): CatalogModel[] {
    const data = (raw as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('redpill: response has no `data` array');

    const out: CatalogModel[] = [];
    for (const entry of data as RedpillModel[]) {
      if (!entry.id) continue;

      const inPerTok = num(entry.pricing?.prompt);
      const outPerTok = num(entry.pricing?.completion);
      if (inPerTok === null || outPerTok === null) {
        throw new Error(`redpill: ${entry.id} has an unreadable price`);
      }
      const ctx = num(entry.context_length);
      if (ctx === null || ctx <= 0) {
        throw new Error(`redpill: ${entry.id} has an unreadable context_length`);
      }

      const params = new Set([
        ...(entry.supported_parameters ?? []),
        ...(entry.supported_features ?? []),
      ]);
      const undeclared = params.size === 0;

      const capabilities: Capability[] = ['text'];
      if (entry.input_modalities?.includes('image')) capabilities.push('vision');
      if (params.has('tools')) capabilities.push('tools');
      if (params.has('structured_outputs') || params.has('json_mode')) capabilities.push('json');
      // `code` is deliberately never derived. No catalog field describes it,
      // and inventing it would let `mesh/coding` pick a model on a guess.

      const tee = entry.is_tee === true;
      const operators = entry.providers ?? [];
      const maxPrivacy: PrivacyLevel = tee ? 'internal' : 'public';

      const stealth = entry.id.startsWith('stealth/');

      out.push({
        id: entry.id,
        ...(entry.name ? { label: entry.name } : {}),
        capabilities,
        undeclared,
        // Per-token to per-million. Verified against redpill.ai/pricing on
        // 2026-08-21: prompt 0.0000003 for qwen3.6-35b-a3b-uncensored matched
        // the published $0.30/MTok, and four other models agreed. Two sources,
        // so the exponent is not being taken on trust.
        contextWindow: Math.floor(ctx),
        price: { inPerMTok: perMTok(inPerTok), outPerMTok: perMTok(outPerTok) },
        maxPrivacy,
        note: tee
          ? `TEE claimed by the vendor; operator(s): ${operators.join(', ') || 'unstated'}`
          : `relay to ${operators.join(', ') || 'an upstream provider'} — not TEE-hosted`,
      });
    }
    return out;
  },
};


interface OpenRouterModel {
  id?: string;
  name?: string;
  context_length?: number;
  expiration_date?: string | null;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  pricing?: Record<string, unknown>;
  supported_parameters?: string[];
}

/**
 * Is every price in this object zero?
 *
 * `pricing` is mostly numeric strings, but one key is not: `overrides` holds a
 * list of time-of-day windows, each with its own `prompt` and `completion` and
 * a `utc_start`/`utc_end` that are hours, not money. **A model can be free at
 * the top level and charge inside a window** — 60 models carried overrides on
 * 2026-08-22, none of them free ones, which is exactly the state in which a
 * naive check looks correct forever and then quietly bills someone. That first
 * free-looking case arrived on 2026-08-28: Nous listed `tencent/hy3:free` with
 * zero top-level prices, but two non-zero override windows covered the whole
 * day (`utc_start` 0->1600 and 1600->0).
 *
 * Anything unreadable throws. An unparseable price is not evidence of zero,
 * and this decides what goes into a file whose entire promise is that its
 * prices are free.
 */
/**
 * Keys inside a pricing override that say *when* it applies, not what it costs.
 *
 * Listed rather than inferred, because two of them are numbers: `min_prompt_tokens`
 * is a threshold, and reading it as money marks a free model paid. The catalog
 * grew `utc_days` and `min_prompt_tokens` between 2026-08-22 and 2026-08-25 —
 * three days — so treat this list as a thing that will need adding to.
 *
 * Everything not named here is money if it parses as a number and an error if
 * it does not. That way a *new* price key is caught rather than skipped: being
 * wrong about "free" is the expensive direction.
 */
const PRICING_CONDITION_KEYS = new Set(['utc_start', 'utc_end', 'utc_days', 'min_prompt_tokens']);

/**
 * `pricing.original` — the undiscounted list prices, not a charge.
 *
 * Nous carries it on 362 of 371 models (2026-08-28): an object mirroring the
 * top-level price keys with what they would cost undiscounted. It is pricing
 * information, but it is not money anybody is asked for, so reading it as a
 * price would reject a model whose prompt and completion are both zero today
 * purely because its list price is not.
 *
 * It is deliberately NOT added to PRICING_CONDITION_KEYS. Those are opaque
 * conditions; this has a known shape whose leaves are prices, and validating
 * every leaf keeps the fail-closed rule: if the object changes shape or grows
 * a value that does not parse, sync stops rather than quietly concluding that
 * the model is free.
 *
 * A zero price with a non-zero `original` is still free at the instant the
 * catalog describes. It carries no expiry and says nothing about the model
 * being temporary, so it is not translated into `expiresAt` or `ephemeral` —
 * that would be inventing a deadline the catalog never gave. If the discount
 * ends, the top-level price stops being zero and the next sync drops it.
 *
 * No zero-priced model carried `original` on 2026-08-28.
 */
function validateOriginalPrices(value: unknown, catalogId: string, id: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${catalogId}: ${id} has an unreadable original price`);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    throw new Error(`${catalogId}: ${id} has an unreadable original price`);
  }
  for (const [kind, price] of entries) {
    if (num(price) === null) {
      throw new Error(`${catalogId}: ${id} has an unreadable original.${kind} price`);
    }
  }
}

function everyPriceZero(
  pricing: Record<string, unknown>,
  id: string,
  catalogId = 'openrouter',
): boolean {
  let free = true;
  for (const [field, value] of Object.entries(pricing)) {
    if (field === 'original') {
      validateOriginalPrices(value, catalogId, id);
      continue;
    }
    if (field === 'overrides') {
      if (!Array.isArray(value)) throw new Error(`${catalogId}: ${id} has an unreadable overrides`);
      for (const window of value as Array<Record<string, unknown>>) {
        for (const [k, v] of Object.entries(window)) {
          if (PRICING_CONDITION_KEYS.has(k)) continue;
          const n = num(v);
          if (n === null) throw new Error(`${catalogId}: ${id} has an unreadable ${k} in overrides`);
          if (n !== 0) free = false;
        }
      }
      continue;
    }
    if (PRICING_CONDITION_KEYS.has(field)) continue;
    const n = num(value);
    if (n === null) throw new Error(`${catalogId}: ${id} has an unreadable ${field} price`);
    if (n !== 0) free = false;
  }
  return free;
}

/**
 * OpenRouter — https://openrouter.ai/api/v1/models
 *
 * **Keyless.** The list is public, which makes this the one catalog that can
 * be refreshed without spending anybody's credit, and it replaces the `curl |
 * jq` line that `providers.default.json` used to carry in a comment.
 *
 * ## Free tier only, on purpose
 *
 * 421 models on 2026-08-22, of which 22 were priced at zero. The registry
 * provider this fills is `openrouter-free` — the free tier is its whole
 * identity — and the shipped registry takes no paid entries, so reading the
 * paid 399 would generate a file that cannot be used where it is aimed.
 *
 * ## What counts as free
 *
 * Every published price must be zero, not just `prompt` and `completion`. The
 * pricing object also carries `web_search`, `image`, `audio`, the cache keys
 * and `internal_reasoning`, and — the one that would actually catch someone —
 * `overrides`, a list of time-of-day windows with prices of their own. A model
 * quoting zero per token while charging inside a window is not free, it is
 * free-looking. No zero-priced model carried overrides on 2026-08-22. The
 * first real example appeared in Nous Portal on 2026-08-28:
 * `tencent/hy3:free` quoted zero at the top level while two non-zero override
 * windows covered the full day. This check rejects it.
 *
 * ## Anonymous previews
 *
 * The `stealth/` namespace is OpenRouter running an unreleased model without
 * saying whose it is. Fourteen of those since April 2025, a median of four to
 * twelve days apiece, and then the id vanishes and the model ships under a
 * real name — so a generated entry for one is guaranteed rot, and `cmdSync`
 * refuses to write them into the shipped registry at all.
 *
 * They also get `maxPrivacy: 'public'` on evidence rather than on default: the
 * operator is anonymous and, by OpenRouter's own description, retains the
 * prompts. "Runs somewhere, kept by someone who will not say who" is the same
 * answer as a keyless endpoint, and it is the only tier that fits.
 *
 * The namespace is the whole detector, which is as much as the catalog gives:
 * on 2026-08-25 nothing else marked these — not the description, not a flag.
 * A preview listed under some other prefix would go unnoticed here.
 *
 * ## No privacy evidence
 *
 * Deliberately absent. OpenRouter is a relay whose upstream is chosen per
 * request, so its catalog says nothing about who ends up holding the text —
 * and where the catalog is silent, `maxPrivacy` stays whatever a human put in
 * the file. RedPill has `is_tee` to reason about; this has nothing.
 */
export const OPENROUTER: CatalogSource = {
  id: 'openrouter-free',
  url: 'https://openrouter.ai/api/v1/models',
  providerApiKeyEnv: 'OPENROUTER_API_KEY',
  caveat:
    'Keyless and free-tier only: models with any non-zero published price are skipped. ' +
    'The catalog carries no privacy evidence, so maxPrivacy is left to the file. ' +
    'expiration_date is read where present — it is the only advance notice a free tier gives.',
  read(raw: unknown): CatalogModel[] {
    const data = (raw as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('openrouter: response has no `data` array');

    const out: CatalogModel[] = [];
    for (const entry of data as OpenRouterModel[]) {
      if (!entry.id) continue;

      const pricing = entry.pricing;
      if (!pricing || typeof pricing !== 'object') {
        throw new Error(`openrouter: ${entry.id} has no pricing object`);
      }
      if (!everyPriceZero(pricing, entry.id)) continue;

      // A model that does not answer in text cannot serve a chat request.
      // The catalog lists image and audio generators at zero alongside the
      // language models, and routing to one would fail every request it won.
      const outputs = entry.architecture?.output_modalities;
      if (Array.isArray(outputs) && outputs.length > 0 && !outputs.includes('text')) continue;

      const ctx = num(entry.context_length);
      if (ctx === null || ctx <= 0) {
        throw new Error(`openrouter: ${entry.id} has an unreadable context_length`);
      }

      const params = new Set(entry.supported_parameters ?? []);
      const capabilities: Capability[] = ['text'];
      if (entry.architecture?.input_modalities?.includes('image')) capabilities.push('vision');
      if (params.has('tools')) capabilities.push('tools');
      if (params.has('response_format') || params.has('structured_outputs')) {
        capabilities.push('json');
      }
      // `code` is never derived here either — no field describes it.

      const stealth = entry.id.startsWith('stealth/');

      out.push({
        id: entry.id,
        ...(entry.name ? { label: entry.name } : {}),
        capabilities,
        // Declaring nothing at all is different from declaring a short list.
        // The modality list counts: a catalog that names the input modalities
        // and no parameters has still told us something, and marking that
        // "undeclared" would make sync warn about a silence that did not happen.
        undeclared: params.size === 0 && !entry.architecture?.input_modalities?.length,
        contextWindow: Math.floor(ctx),
        // Zero, verified by the loop above rather than assumed from the id.
        // A ':free' suffix is a naming convention, not a price.
        price: { inPerMTok: 0, outPerMTok: 0 },
        ...(entry.expiration_date ? { expiresAt: entry.expiration_date } : {}),
        ...(stealth ? { ephemeral: true, maxPrivacy: 'public' as PrivacyLevel } : {}),
        note: stealth
          ? 'anonymous preview: operator undisclosed, prompts retained by them, listing withdrawn within weeks'
          : 'free tier on OpenRouter; upstream operator chosen per request',
      });
    }
    return out;
  },
};

/**
 * Nous Portal — https://inference-api.nousresearch.com/v1/models
 *
 * The catalog is public and uses the same OpenRouter-compatible shape as
 * OpenRouter's model list. Inference still requires `NOUS_API_KEY`.
 *
 * Free means every price at every level is zero. On 2026-08-28 the catalog
 * carried 371 models, six of them zero-priced at the top level — but
 * `tencent/hy3:free` had two non-zero override windows covering the entire
 * day. `everyPriceZero` therefore leaves five genuinely free candidates.
 *
 * This reader records catalog facts only. Shipped entries stay disabled until
 * a key exists and `probe` confirms the ids actually serve.
 */
export const NOUS: CatalogSource = {
  id: 'nous',
  url: 'https://inference-api.nousresearch.com/v1/models',
  providerApiKeyEnv: 'NOUS_API_KEY',
  caveat:
    'Keyless catalog and free-tier only: every top-level and override price must be zero. ' +
    'Catalog presence is not a successful probe; generated entries stay disabled until tested.',
  read(raw: unknown): CatalogModel[] {
    const data = (raw as { data?: unknown })?.data;
    if (!Array.isArray(data)) throw new Error('nous: response has no `data` array');

    const out: CatalogModel[] = [];
    for (const entry of data as OpenRouterModel[]) {
      if (!entry.id) continue;

      const pricing = entry.pricing;
      if (!pricing || typeof pricing !== 'object') {
        throw new Error(`nous: ${entry.id} has no pricing object`);
      }
      if (!everyPriceZero(pricing, entry.id, 'nous')) continue;

      const outputs = entry.architecture?.output_modalities;
      if (Array.isArray(outputs) && outputs.length > 0 && !outputs.includes('text')) continue;

      const ctx = num(entry.context_length);
      if (ctx === null || ctx <= 0) {
        throw new Error(`nous: ${entry.id} has an unreadable context_length`);
      }

      const params = new Set(entry.supported_parameters ?? []);
      const inputs = entry.architecture?.input_modalities ?? [];
      const capabilities: Capability[] = ['text'];
      if (inputs.includes('image')) capabilities.push('vision');
      if (inputs.includes('video')) capabilities.push('video');
      if (params.has('tools')) capabilities.push('tools');
      if (params.has('response_format') || params.has('structured_outputs')) {
        capabilities.push('json');
      }

      out.push({
        id: entry.id,
        ...(entry.name ? { label: entry.name } : {}),
        capabilities,
        undeclared: params.size === 0 && inputs.length === 0,
        contextWindow: Math.floor(ctx),
        price: { inPerMTok: 0, outPerMTok: 0 },
        note: 'free tier listed by Nous Portal; inference not yet probed',
      });
    }
    return out;
  },
};

export const CATALOGS: Record<string, CatalogSource> = {
  redpill: REDPILL,
  openrouter: OPENROUTER,
  nous: NOUS,
};
