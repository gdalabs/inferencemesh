/**
 * Adapter contract.
 *
 * An adapter's only job is to translate one provider's wire format to and from
 * the OpenAI chat shape. It must not retry, must not fall back, and must not
 * look at the registry — all of that belongs to the mesh, which is the only
 * place that can see the whole candidate chain.
 */

import type { Candidate, ChatRequest, ChatResponse } from '../types.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AdapterContext {
  candidate: Candidate;
  apiKey: string;
  /** Cloudflare account id and similar path parameters. */
  accountId?: string;
  request: ChatRequest;
  signal?: AbortSignal;
  fetchImpl: FetchLike;
}

export interface Adapter {
  readonly kind: string;
  chat(ctx: AdapterContext): Promise<ChatResponse>;
  /**
   * Server-sent events in OpenAI `chat.completion.chunk` format, terminated by
   * `data: [DONE]`. Adapters that stream a different shape transform it here so
   * the caller never learns which provider answered.
   */
  stream(ctx: AdapterContext): Promise<ReadableStream<Uint8Array>>;
}

/** A provider returned a non-2xx. Carries what the mesh needs to decide next. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryAfterMs?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /**
   * Whether trying a different provider could plausibly succeed.
   *
   * 400/422 are the request's fault and will fail identically everywhere, so
   * failing over on them just multiplies the same error by the chain length.
   * 401/403 are this key's fault, which the *next* provider does not share.
   */
  get failoverable(): boolean {
    if (this.status === 400 || this.status === 422) return false;
    return true;
  }
}

export function parseRetryAfter(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) {
    // OpenAI-style millisecond hints, used by Groq among others.
    const ms = res.headers.get('x-ratelimit-reset-requests') ?? res.headers.get('x-ratelimit-reset-tokens');
    if (ms) {
      const parsed = parseDuration(ms);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  }
  const secs = Number(raw);
  if (Number.isFinite(secs)) return secs * 1000;
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** '1.5s', '250ms', '2m30s' -> ms. Returns undefined when unparseable. */
export function parseDuration(raw: string): number | undefined {
  const m = raw.match(/^(?:(\d+(?:\.\d+)?)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+(?:\.\d+)?)ms)?$/);
  if (!m || (!m[1] && !m[2] && !m[3])) {
    const n = Number(raw);
    return Number.isFinite(n) ? n * 1000 : undefined;
  }
  return Number(m[1] ?? 0) * 60_000 + Number(m[2] ?? 0) * 1000 + Number(m[3] ?? 0);
}

export async function toProviderError(res: Response): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* body already consumed or connection died; the status still tells us enough */
  }
  let message = `${res.status} ${res.statusText}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const err = parsed.error;
    const detail = typeof err === 'string' ? err : (err?.message ?? parsed.message);
    if (detail) message = `${res.status} ${detail}`;
  } catch {
    if (body) message = `${res.status} ${body.slice(0, 300)}`;
  }
  return new ProviderError(message, res.status, parseRetryAfter(res), body.slice(0, 2000));
}

/** Strip InferenceMesh extensions before anything goes on the wire. */
export function stripMeshFields(req: ChatRequest): Omit<ChatRequest, 'mesh'> {
  const { mesh: _mesh, ...rest } = req;
  return rest;
}

const encoder = new TextEncoder();

export function sseLine(payload: unknown): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export const SSE_DONE = encoder.encode('data: [DONE]\n\n');
