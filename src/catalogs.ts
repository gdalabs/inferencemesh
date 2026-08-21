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

export const CATALOGS: Record<string, CatalogSource> = {
  redpill: REDPILL,
};
