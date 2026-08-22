/**
 * Provider registry: config in, validated candidates out.
 *
 * Loading is where BYOK is enforced. A provider whose API key is missing is
 * dropped — but *loudly*, into `warnings`, because "no candidates" caused by a
 * typo'd env var name is otherwise indistinguishable from "everything is rate
 * limited", and both surface as a 503 at 3am.
 */

import {
  PRIVACY_ORDER,
  type Candidate,
  type Capability,
  type LanguageTag,
  type MeshProfile,
  type ModelEntry,
  type PrivacyLevel,
  type ProviderConfig,
} from './types.js';

/** Score used for a language the registry says nothing about. */
export const DEFAULT_LANGUAGE_SCORE = 0.6;

/**
 * Score used for a model nobody has rated.
 *
 * Neutral on purpose, not optimistic. Latency and reliability are scored
 * optimistically when untried because one request *measures* them and the
 * optimism is repaid; quality is never measured by routing, so an optimistic
 * default would park every unrated model above every rated one permanently.
 * The middle says "unknown" and lets the other terms decide.
 */
export const DEFAULT_QUALITY_SCORE = 0.5;

export const DEFAULT_PROFILES: Record<string, MeshProfile> = {
  free: {
    name: 'free',
    freeOnly: true,
    weights: { quality: 0.4, cost: 0.0, latency: 0.2, language: 0.2, reliability: 0.2 },
  },
  cheap: {
    name: 'cheap',
    weights: { quality: 0.2, cost: 0.45, latency: 0.05, language: 0.15, reliability: 0.15 },
  },
  fast: {
    name: 'fast',
    weights: { quality: 0.15, cost: 0.1, latency: 0.45, language: 0.1, reliability: 0.2 },
  },
  best: {
    name: 'best',
    weights: { quality: 0.5, cost: 0.0, latency: 0.05, language: 0.3, reliability: 0.15 },
  },
  /**
   * `private` is not a weighting — it is a filter. The privacy floor is applied
   * from the request's `privacy` field, so this profile only exists to make the
   * intent explicit at the call site and to stop free tiers winning by price.
   */
  private: {
    name: 'private',
    weights: { quality: 0.5, cost: 0.1, latency: 0.1, language: 0.15, reliability: 0.15 },
  },
  coding: {
    name: 'coding',
    requireCapabilities: ['code'],
    weights: { quality: 0.5, cost: 0.15, latency: 0.1, language: 0.1, reliability: 0.15 },
  },
  vision: {
    name: 'vision',
    requireCapabilities: ['vision'],
    weights: { quality: 0.4, cost: 0.15, latency: 0.1, language: 0.15, reliability: 0.2 },
  },
};

export interface RegistryOptions {
  /** Environment to resolve `apiKeyEnv` against. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  profiles?: Record<string, MeshProfile>;
  defaultProfile?: string;
}

export interface LoadWarning {
  providerId: string;
  reason: string;
}

export class Registry {
  readonly providers: ProviderConfig[];
  readonly candidates: Candidate[];
  readonly warnings: LoadWarning[];
  readonly profiles: Record<string, MeshProfile>;
  readonly defaultProfile: string;
  private readonly keys = new Map<string, string>();
  private readonly accountIds = new Map<string, string>();

  constructor(configs: ProviderConfig[], opts: RegistryOptions = {}) {
    const env = opts.env ?? (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
    this.profiles = { ...DEFAULT_PROFILES, ...(opts.profiles ?? {}) };
    this.defaultProfile = opts.defaultProfile ?? 'free';
    if (!this.profiles[this.defaultProfile]) {
      throw new Error(`default profile '${this.defaultProfile}' is not defined`);
    }

    this.warnings = [];
    this.providers = [];

    for (const p of configs) {
      if (p.disabled) {
        this.warnings.push({ providerId: p.id, reason: 'disabled in config' });
        continue;
      }
      const key = env[p.apiKeyEnv];
      if (!key && !p.apiKeyOptional) {
        this.warnings.push({ providerId: p.id, reason: `missing env ${p.apiKeyEnv}` });
        continue;
      }
      if (p.accountIdEnv) {
        const account = env[p.accountIdEnv];
        if (!account) {
          this.warnings.push({ providerId: p.id, reason: `missing env ${p.accountIdEnv}` });
          continue;
        }
        this.accountIds.set(p.id, account);
      }
      this.keys.set(p.id, key ?? '');
      this.providers.push(p);
    }

    this.candidates = [];
    for (const provider of this.providers) {
      for (const model of provider.models) {
        if (model.disabled) continue;
        this.candidates.push({ provider, model, key: `${provider.id}/${model.id}` });
      }
    }
  }

  /** Empty string means "this provider takes no credential" — see apiKeyOptional. */
  apiKey(providerId: string): string {
    const k = this.keys.get(providerId);
    if (k === undefined) throw new Error(`no API key loaded for provider '${providerId}'`);
    return k;
  }

  accountId(providerId: string): string | undefined {
    return this.accountIds.get(providerId);
  }

  profile(name?: string): MeshProfile {
    const p = this.profiles[name ?? this.defaultProfile];
    if (!p) throw new Error(`unknown mesh profile '${name}'`);
    return p;
  }

  find(key: string): Candidate | undefined {
    return this.candidates.find((c) => c.key === key);
  }
}

/* -------------------------------------------------------------------------- */
/* Derived helpers used by both routing and reporting                         */
/* -------------------------------------------------------------------------- */

/**
 * Blended price in USD per million tokens, assuming a 3:1 input:output mix.
 *
 * A single number is needed for ranking; the 3:1 mix is a chat-shaped guess and
 * is documented rather than hidden because it decides which model is "cheaper".
 */
export function blendedPrice(model: ModelEntry): number {
  return model.price.inPerMTok * 0.75 + model.price.outPerMTok * 0.25;
}

/** A model's quality, or the neutral stand-in when it is unrated. */
export function qualityScore(model: ModelEntry): number {
  return model.quality ?? DEFAULT_QUALITY_SCORE;
}

export function isFree(model: ModelEntry): boolean {
  return model.price.inPerMTok === 0 && model.price.outPerMTok === 0;
}

export function languageScore(model: ModelEntry, language: LanguageTag | undefined): number {
  if (!language) return 1;
  const langs = model.languages;
  if (!langs) return DEFAULT_LANGUAGE_SCORE;
  const tag = language.toLowerCase();
  if (langs[tag] !== undefined) return langs[tag] as number;
  const base = tag.split('-')[0] as string;
  if (langs[base] !== undefined) return langs[base] as number;
  if (langs['*'] !== undefined) return langs['*'] as number;
  return DEFAULT_LANGUAGE_SCORE;
}

/**
 * What the entry actually *says* about a language, or undefined if it says
 * nothing. Distinct from `languageScore`, which always returns a number.
 *
 * The difference is the whole basis for contradicting a registry. `languages:
 * { en: 0.9 }` asked about Japanese falls back to `DEFAULT_LANGUAGE_SCORE`,
 * which is 0.6 — above the threshold for "this language is served". Treating
 * that as a claim means a model that never claimed Japanese gets faulted for
 * not answering in it, and the report is measuring its own default rather than
 * the file. Routing wants the fallback; a disagreement check must not have it.
 */
export function declaredLanguageScore(
  model: ModelEntry,
  language: LanguageTag | undefined,
): number | undefined {
  if (!language) return undefined;
  const langs = model.languages;
  if (!langs) return undefined;
  const tag = language.toLowerCase();
  const base = tag.split('-')[0] as string;
  return langs[tag] ?? langs[base] ?? langs['*'];
}

export function maxPrivacyOf(candidate: Candidate): PrivacyLevel {
  return candidate.model.maxPrivacy ?? candidate.provider.maxPrivacy;
}

export function servesPrivacy(candidate: Candidate, level: PrivacyLevel): boolean {
  return PRIVACY_ORDER[maxPrivacyOf(candidate)] >= PRIVACY_ORDER[level];
}

export function hasCapabilities(model: ModelEntry, required: Capability[] | undefined): boolean {
  if (!required || required.length === 0) return true;
  return required.every((c) => model.capabilities.includes(c));
}

/** Cost of one call in USD, from real usage. */
export function costOf(model: ModelEntry, promptTokens: number, completionTokens: number): number {
  return (
    (promptTokens / 1_000_000) * model.price.inPerMTok +
    (completionTokens / 1_000_000) * model.price.outPerMTok
  );
}
