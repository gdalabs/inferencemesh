/**
 * Core types for InferenceMesh.
 *
 * Everything here is data, not behaviour, so a host application can serialise a
 * registry to JSON, ship it to a Worker, and get identical routing decisions.
 */

/** What a model can be asked to do. Used as a hard filter during routing. */
export type Capability =
  | 'text'
  | 'code'
  | 'vision'
  | 'ocr'
  | 'image'
  | 'voice'
  | 'music'
  | 'video'
  | 'embedding'
  | 'rerank'
  | 'tools'
  | 'json';

/**
 * Sensitivity of the payload. A model may only serve a request whose privacy
 * level is at or below the model's own `maxPrivacy`.
 *
 * The ordering matters and is defined by PRIVACY_ORDER below.
 */
export type PrivacyLevel = 'public' | 'internal' | 'confidential' | 'highly_confidential';

export const PRIVACY_ORDER: Record<PrivacyLevel, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  highly_confidential: 3,
};

/** BCP-47-ish language tag, lowercased. 'ja', 'en', 'zh-hans', ... */
export type LanguageTag = string;

/** Wire protocol an adapter speaks. */
export type ProviderKind = 'openai-compat' | 'gemini' | 'workers-ai';

export interface Quota {
  /** Hard cap on requests inside a rolling minute. */
  requestsPerMinute?: number;
  /** Hard cap on requests inside a calendar day (UTC). */
  requestsPerDay?: number;
  /** Hard cap on total tokens inside a calendar day (UTC). */
  tokensPerDay?: number;
}

export interface Price {
  /** USD per million input tokens. 0 means free tier. */
  inPerMTok: number;
  /** USD per million output tokens. 0 means free tier. */
  outPerMTok: number;
}

export interface ModelEntry {
  /** Provider-native model id, sent verbatim on the wire. */
  id: string;
  /** Optional display name. */
  label?: string;
  capabilities: Capability[];
  /** Max context in tokens. Used as a hard filter via `minContext`. */
  contextWindow: number;
  price: Price;
  /**
   * Subjective general quality, 0..1. Hand-maintained; the point is *relative*
   * ordering inside one registry, not a benchmark claim.
   */
  quality: number;
  /**
   * Per-language competence, 0..1. A missing tag falls back to
   * `languages['*']`, then to `DEFAULT_LANGUAGE_SCORE`.
   */
  languages?: Record<LanguageTag, number>;
  /**
   * Date (YYYY-MM-DD) the price above was last checked against the provider's
   * own pricing page. REQUIRED for any non-zero price: a stale price does not
   * fail, it silently reorders the 'cheap' profile.
   */
  priceVerifiedAt?: string;
  /** Highest sensitivity this model may serve. Defaults to the provider's. */
  maxPrivacy?: PrivacyLevel;
  quota?: Quota;
  /** Excluded from routing while true. Keeps the entry around for diffing. */
  disabled?: boolean;
}

export interface ProviderConfig {
  id: string;
  kind: ProviderKind;
  /** Base URL without a trailing slash. For workers-ai, without /v1. */
  baseUrl: string;
  /**
   * Name of the environment variable holding the API key (BYOK).
   * A provider whose key is absent is dropped from the registry at load time.
   */
  apiKeyEnv: string;
  /**
   * Set when the provider serves requests with no credential at all.
   *
   * Rare but real: a few providers run an open free tier to acquire users. The
   * provider is then loaded even with no key, and the adapter sends no
   * Authorization header — sending an empty bearer token is worse than sending
   * none, because some gateways reject the malformed header outright.
   */
  apiKeyOptional?: boolean;
  /** Cloudflare account id, workers-ai only. Read from env if it names one. */
  accountIdEnv?: string;
  /** Highest sensitivity any model of this provider may serve. */
  maxPrivacy: PrivacyLevel;
  /**
   * Where a human goes to get the key. Required for anything with an
   * `apiKeyEnv`, because "set GROQ_API_KEY" is only actionable if you already
   * know Groq exists — which is exactly the knowledge this tool exists to
   * remove the need for.
   */
  signupUrl?: string;
  /** One line, shown during setup: what this provider gives you. */
  summary?: string;
  /** Shown during setup: what it costs and what the free tier allows. */
  freeTierNote?: string;
  /**
   * What the key looks like, e.g. 'nvapi-'. Used for an instant client-side
   * sanity check so someone who copied the wrong string off the page is told
   * so before a network call, and so the UI can show what to look for.
   * A missing prefix means "no recognisable shape" — never treat that as invalid.
   */
  keyPrefix?: string;
  /**
   * Click-by-click steps to obtain the key, per language.
   *
   * This is the actual product. "Set NVIDIA_API_KEY" assumes you already know
   * the page exists, what to click on it, and which of the several strings on
   * the result screen is the one to copy — which is exactly the knowledge that
   * is missing.
   */
  signupSteps?: Record<string, string[]>;
  /** Extra headers merged into every request (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  models: ModelEntry[];
  disabled?: boolean;
}

/** A provider+model pair, which is what routing actually selects. */
export interface Candidate {
  provider: ProviderConfig;
  model: ModelEntry;
  /** `${provider.id}/${model.id}` — stable key for ledger and health. */
  key: string;
}

/** Named routing intents exposed to callers as `mesh/<name>`. */
export interface MeshProfile {
  name: string;
  /** Reject anything that costs money. */
  freeOnly?: boolean;
  /** Reject candidates whose blended price exceeds this (USD per MTok). */
  maxPricePerMTok?: number;
  /** Capabilities every candidate must have, on top of the request's. */
  requireCapabilities?: Capability[];
  /**
   * Scoring weights. Need not sum to 1; they are normalised at scoring time.
   *
   * A term that is identical across every candidate cannot change the ordering,
   * it only shifts all scores equally. That matters once a registry is
   * generated rather than curated: with uniform quality, uniform language and
   * an all-free pool, `latency` and `reliability` are the only terms doing any
   * work, and the ranking becomes "fastest thing that is actually answering".
   */
  weights: {
    quality: number;
    /** Rewards cheap candidates. */
    cost: number;
    /** Rewards low observed latency. */
    latency: number;
    /** Rewards competence in the requested language. */
    language: number;
    /** Rewards a high observed success rate. Optional for older configs. */
    reliability?: number;
  };
}

export interface RouteRequest {
  /** Mesh profile name, e.g. 'free'. Defaults to the registry default. */
  mesh?: string;
  /** Requested output language. Drives the language term of the score. */
  language?: LanguageTag;
  /** Sensitivity of the payload. Defaults to 'public'. */
  privacy?: PrivacyLevel;
  /** Hard capability filter. */
  capabilities?: Capability[];
  /** Reject models with a smaller context window. */
  minContext?: number;
  /** Pin to a specific `provider/model`, bypassing scoring but not filters. */
  pin?: string;
  /** Estimated tokens for this call; used for token-quota admission. */
  estimatedTokens?: number;
}

export interface ScoredCandidate {
  candidate: Candidate;
  score: number;
  /** Per-term contributions, for explaining a decision. */
  terms: Record<string, number>;
}

/** Why a candidate was dropped. Surfaced so a 'no candidates' error is debuggable. */
export interface Rejection {
  key: string;
  reason: string;
}

export interface RouteDecision {
  /** Best first. Later entries are the fallback chain. */
  ranked: ScoredCandidate[];
  rejected: Rejection[];
  profile: MeshProfile;
}

/* -------------------------------------------------------------------------- */
/* Chat wire format (OpenAI-compatible subset)                                */
/* -------------------------------------------------------------------------- */

export interface ChatContentPartText {
  type: 'text';
  text: string;
}

export interface ChatContentPartImage {
  type: 'image_url';
  image_url: { url: string; detail?: string };
}

export type ChatContentPart = ChatContentPartText | ChatContentPartImage;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ChatContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

export interface ChatRequest {
  /** `mesh/free`, `mesh/best`, or `provider/model` to pin. */
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: { type: string; [k: string]: unknown };
  /** InferenceMesh extensions. Ignored by providers; stripped before sending. */
  mesh?: Omit<RouteRequest, 'mesh'>;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatChoice {
  index: number;
  message: ChatMessage;
  finish_reason: string | null;
}

export interface ChatResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatChoice[];
  usage?: Usage;
  /** Non-standard: which provider/model actually served this. */
  mesh?: MeshTrace;
}

export interface MeshTrace {
  /** `provider/model` that produced the response. */
  served_by: string;
  profile: string;
  /** Keys tried and failed, in order. */
  attempts: Array<{ key: string; status?: number; error: string; ms: number }>;
  latency_ms: number;
  /** USD, computed from usage and the registry price. 0 for free tiers. */
  cost_usd: number;
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class MeshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'MeshError';
  }
}

/** Thrown when every candidate was filtered out or every attempt failed. */
export class NoCandidateError extends MeshError {
  constructor(message: string, readonly rejected: Rejection[]) {
    super(message, 503, 'no_candidate', rejected);
    this.name = 'NoCandidateError';
  }
}
