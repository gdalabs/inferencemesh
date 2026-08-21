/**
 * Config parsing. Runtime-agnostic: takes an already-parsed object, so the same
 * code path serves a Node `fs.readFile`, a Worker's bundled import, and a KV get.
 */

import { Registry, type RegistryOptions } from './registry.js';
import type { MeshProfile, ProviderConfig } from './types.js';

export interface RegistryFile {
  verifiedAt?: string;
  providers: ProviderConfig[];
  profiles?: Record<string, MeshProfile>;
  defaultProfile?: string;
}

const VALID_KINDS = new Set(['openai-compat', 'gemini', 'workers-ai']);

/**
 * Validate a registry file.
 *
 * This runs before any key lookup on purpose: a typo in `capabilities` should
 * be a startup error, not a mysteriously empty candidate pool three weeks later.
 */
export function validateRegistryFile(raw: unknown): RegistryFile {
  if (typeof raw !== 'object' || raw === null) throw new Error('registry: not an object');
  const file = raw as RegistryFile;
  if (!Array.isArray(file.providers)) throw new Error('registry: `providers` must be an array');

  const seen = new Set<string>();
  for (const p of file.providers) {
    if (!p.id) throw new Error('registry: provider without an id');
    if (seen.has(p.id)) throw new Error(`registry: duplicate provider id '${p.id}'`);
    seen.add(p.id);
    if (!VALID_KINDS.has(p.kind)) {
      throw new Error(`registry: provider '${p.id}' has unknown kind '${p.kind}'`);
    }
    if (!p.baseUrl) throw new Error(`registry: provider '${p.id}' has no baseUrl`);
    if (!p.apiKeyEnv) throw new Error(`registry: provider '${p.id}' has no apiKeyEnv`);
    if (!p.maxPrivacy) throw new Error(`registry: provider '${p.id}' has no maxPrivacy`);
    if (!Array.isArray(p.models) || p.models.length === 0) {
      throw new Error(`registry: provider '${p.id}' has no models`);
    }
    // 0 would mean "never routable", which is what `disabled` is for. Rejecting
    // it here keeps a typo from silently removing a provider from every chain.
    if (
      p.maxConcurrent !== undefined &&
      (!Number.isInteger(p.maxConcurrent) || p.maxConcurrent < 1)
    ) {
      throw new Error(
        `registry: provider '${p.id}' has an invalid maxConcurrent ` +
          `(${String(p.maxConcurrent)}); expected an integer >= 1, or omit it for unlimited`,
      );
    }
    const modelIds = new Set<string>();
    for (const m of p.models) {
      if (!m.id) throw new Error(`registry: provider '${p.id}' has a model without an id`);
      if (modelIds.has(m.id)) {
        throw new Error(`registry: provider '${p.id}' has duplicate model '${m.id}'`);
      }
      modelIds.add(m.id);
      if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
        throw new Error(`registry: ${p.id}/${m.id} has no capabilities`);
      }
      if (!Number.isFinite(m.contextWindow) || m.contextWindow <= 0) {
        throw new Error(`registry: ${p.id}/${m.id} has an invalid contextWindow`);
      }
      if (!m.price || !Number.isFinite(m.price.inPerMTok) || !Number.isFinite(m.price.outPerMTok)) {
        throw new Error(`registry: ${p.id}/${m.id} has an invalid price`);
      }
      // Absent is allowed and means unrated. A present value still has to be a
      // real number in range: `quality: null` or `"0.8"` must not slip through
      // as "unrated", because that reads as a deliberate omission when it is a
      // broken one.
      if (m.quality !== undefined && (!Number.isFinite(m.quality) || m.quality < 0 || m.quality > 1)) {
        throw new Error(`registry: ${p.id}/${m.id} quality must be within 0..1, or absent if unrated`);
      }
      if (
        m.privacyVerifiedAt !== undefined &&
        !/^\d{4}-\d{2}-\d{2}$/.test(m.privacyVerifiedAt)
      ) {
        throw new Error(
          `registry: ${p.id}/${m.id} has an invalid privacyVerifiedAt ` +
            `('${m.privacyVerifiedAt}'); expected YYYY-MM-DD`,
        );
      }
      // A paid model must carry the date its price was checked. Free tiers are
      // exempt because 0 is true by definition; every other number rots.
      const paid = m.price.inPerMTok !== 0 || m.price.outPerMTok !== 0;
      if (paid && !/^\d{4}-\d{2}-\d{2}$/.test(m.priceVerifiedAt ?? '')) {
        throw new Error(
          `registry: ${p.id}/${m.id} has a non-zero price but no valid priceVerifiedAt ` +
            `(YYYY-MM-DD). Check the provider's pricing page and record the date.`,
        );
      }
    }
  }
  return file;
}

export function registryFrom(raw: unknown, opts: RegistryOptions = {}): Registry {
  const file = validateRegistryFile(raw);
  return new Registry(file.providers, {
    ...opts,
    ...(file.profiles ? { profiles: { ...file.profiles, ...(opts.profiles ?? {}) } } : {}),
    ...(file.defaultProfile && !opts.defaultProfile ? { defaultProfile: file.defaultProfile } : {}),
  });
}
