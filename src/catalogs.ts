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
 * naive check looks correct forever and then quietly bills someone.
 *
 * Anything unreadable throws. An unparseable price is not evidence of zero,
 * and this decides what goes into a file whose entire promise is that its
 * prices are free.
 */
function everyPriceZero(pricing: Record<string, unknown>, id: string): boolean {
  let free = true;
  for (const [field, value] of Object.entries(pricing)) {
    if (field === 'overrides') {
      if (!Array.isArray(value)) throw new Error(`openrouter: ${id} has an unreadable overrides`);
      for (const window of value as Array<Record<string, unknown>>) {
        for (const [k, v] of Object.entries(window)) {
          // Hours, not money.
          if (k === 'utc_start' || k === 'utc_end') continue;
          const n = num(v);
          if (n === null) throw new Error(`openrouter: ${id} has an unreadable ${k} in overrides`);
          if (n !== 0) free = false;
        }
      }
      continue;
    }
    const n = num(value);
    if (n === null) throw new Error(`openrouter: ${id} has an unreadable ${field} price`);
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
 * free-looking. No zero-priced model carried overrides on 2026-08-22; the
 * check is here because the day one does is the day nobody re-reads this.
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
        note: 'free tier on OpenRouter; upstream operator chosen per request',
      });
    }
    return out;
  },
};

export const CATALOGS: Record<string, CatalogSource> = {
  redpill: REDPILL,
  openrouter: OPENROUTER,
};
