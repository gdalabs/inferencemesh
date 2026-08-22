/**
 * Config parsing. Runtime-agnostic: takes an already-parsed object, so the same
 * code path serves a Node `fs.readFile`, a Worker's bundled import, and a KV get.
 */

import { DEFAULT_PROFILES, Registry, type RegistryOptions } from './registry.js';
import { PRIVACY_ORDER, type Capability, type MeshProfile, type ProviderConfig } from './types.js';

export interface RegistryFile {
  verifiedAt?: string;
  providers: ProviderConfig[];
  profiles?: Record<string, MeshProfile>;
  defaultProfile?: string;
}

const VALID_KINDS = new Set(['openai-compat', 'gemini', 'workers-ai']);

/**
 * Every capability the router understands.
 *
 * Listed here rather than derived, because a union type does not survive to
 * runtime and this file's whole job is catching what TypeScript cannot see: a
 * hand-edited JSON file. `capabilities: ['tols']` type-checks nowhere and used
 * to validate fine, leaving a model that quietly lost every tools request —
 * the exact "mysteriously empty candidate pool three weeks later" this
 * function exists to prevent.
 */
export const VALID_CAPABILITIES = new Set<string>([
  'text',
  'code',
  'vision',
  'ocr',
  'image',
  'voice',
  'music',
  'video',
  'embedding',
  'rerank',
  'tools',
  'json',
] satisfies Capability[]);

const DATE = /^\d{4}-\d{2}-\d{2}$/;

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
      for (const cap of m.capabilities) {
        if (!VALID_CAPABILITIES.has(cap)) {
          throw new Error(
            `registry: ${p.id}/${m.id} has unknown capability '${String(cap)}'. ` +
              `Known: ${[...VALID_CAPABILITIES].join(', ')}`,
          );
        }
      }
      if (m.maxPrivacy !== undefined && !(m.maxPrivacy in PRIVACY_ORDER)) {
        // A typo here does not fail loudly anywhere else: the comparison just
        // comes out false and the model is silently unroutable at every tier.
        throw new Error(
          `registry: ${p.id}/${m.id} has unknown maxPrivacy '${String(m.maxPrivacy)}'. ` +
            `Known: ${Object.keys(PRIVACY_ORDER).join(', ')}`,
        );
      }
      if (m.languages !== undefined) {
        for (const [tag, score] of Object.entries(m.languages)) {
          if (!Number.isFinite(score) || score < 0 || score > 1) {
            // 72 for 0.72 is the one that hurts: it does not error, it just
            // wins every comparison it is in, for every caller of that language.
            throw new Error(
              `registry: ${p.id}/${m.id} language '${tag}' must be within 0..1 (got ${String(score)})`,
            );
          }
        }
      }
      if (m.expiresAt !== undefined && !DATE.test(m.expiresAt)) {
        throw new Error(
          `registry: ${p.id}/${m.id} has an invalid expiresAt ('${m.expiresAt}'); expected YYYY-MM-DD`,
        );
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
        m.privacyVerifiedAt !== undefined && !DATE.test(m.privacyVerifiedAt)
      ) {
        throw new Error(
          `registry: ${p.id}/${m.id} has an invalid privacyVerifiedAt ` +
            `('${m.privacyVerifiedAt}'); expected YYYY-MM-DD`,
        );
      }
      // A paid model must carry the date its price was checked. Free tiers are
      // exempt because 0 is true by definition; every other number rots.
      const paid = m.price.inPerMTok !== 0 || m.price.outPerMTok !== 0;
      if (paid && !DATE.test(m.priceVerifiedAt ?? '')) {
        throw new Error(
          `registry: ${p.id}/${m.id} has a non-zero price but no valid priceVerifiedAt ` +
            `(YYYY-MM-DD). Check the provider's pricing page and record the date.`,
        );
      }
    }
  }

  // Caught here as well as in the Registry constructor, so a bad file fails
  // where the rest of the file's problems are reported rather than later.
  if (file.defaultProfile !== undefined) {
    // The built-ins come from the same object the Registry merges in — a
    // second hand-written list of profile names would go stale the first time
    // one is added, and reject a file that is perfectly valid.
    const known = { ...DEFAULT_PROFILES, ...(file.profiles ?? {}) };
    if (!known[file.defaultProfile]) {
      throw new Error(
        `registry: defaultProfile '${file.defaultProfile}' is not defined in \`profiles\``,
      );
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
