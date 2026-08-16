/**
 * The mesh: route, attempt, fall back, book.
 *
 * This is the only object that sees the whole picture, and therefore the only
 * one allowed to retry. Adapters fail once and say why; the mesh decides
 * whether "why" is worth trying somebody else for.
 */

import { HealthTracker } from './health.js';
import { QuotaLedger } from './ledger.js';
import { Router } from './router.js';
import { costOf, type Registry } from './registry.js';
import { ProviderError, type Adapter, type FetchLike } from './providers/base.js';
import { GeminiAdapter } from './providers/gemini.js';
import { OpenAICompatAdapter } from './providers/openai-compat.js';
import {
  MeshError,
  NoCandidateError,
  type ChatRequest,
  type ChatResponse,
  type MeshTrace,
  type RouteRequest,
  type Usage,
} from './types.js';

export interface MeshEvent {
  type: 'route' | 'attempt' | 'success' | 'failure' | 'exhausted';
  key?: string;
  profile?: string;
  status?: number;
  error?: string;
  ms?: number;
  costUsd?: number;
  usage?: Usage;
}

export interface MeshOptions {
  registry: Registry;
  ledger?: QuotaLedger;
  health?: HealthTracker;
  fetchImpl?: FetchLike;
  adapters?: Record<string, Adapter>;
  /** Per-attempt timeout. The whole chain can take up to attempts × this. */
  timeoutMs?: number;
  /** Cap on how far down the ranked chain to walk. */
  maxAttempts?: number;
  onEvent?: (e: MeshEvent) => void;
}

/**
 * Cheap token estimate for quota admission only.
 *
 * ~4 characters per token is right for English and wrong for Japanese (closer
 * to 1). It is used exclusively to admit against a *daily* cap, where being
 * off by 2x costs an early cutoff rather than a bad answer — real usage is
 * booked from the provider's own count once the call returns.
 */
export function estimateTokens(req: ChatRequest): number {
  let chars = 0;
  for (const m of req.messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'text') chars += p.text.length;
    }
  }
  return Math.ceil(chars / 4) + (req.max_tokens ?? 512);
}

/**
 * Split an addressed model into a routing request.
 *
 *   'mesh/free'                   -> profile 'free'
 *   'groq/llama-3.3-70b'          -> pinned candidate
 *   'openrouter/deepseek/chat-v4' -> pinned candidate (model ids may contain /)
 */
export function parseModel(model: string): RouteRequest {
  const slash = model.indexOf('/');
  if (slash === -1) return { pin: model };
  const head = model.slice(0, slash);
  if (head === 'mesh') return { mesh: model.slice(slash + 1) };
  return { pin: model };
}

interface AttemptSignal {
  signal: AbortSignal;
  /**
   * Stop the timeout while leaving caller-abort wired up.
   *
   * A streaming response must call this the moment headers arrive: the timeout
   * bounds how long a provider may take to *start* answering, and leaving it
   * armed would cut a legitimately long completion off mid-sentence.
   */
  clearTimer: () => void;
  /** Release everything. Safe to call twice. */
  detach: () => void;
}

function combineSignals(timeoutMs: number, caller?: AbortSignal): AttemptSignal {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`attempt timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => ctrl.abort(caller?.reason);
  if (caller) {
    if (caller.aborted) ctrl.abort(caller.reason);
    else caller.addEventListener('abort', onAbort, { once: true });
  }
  const clearTimer = () => clearTimeout(timer);
  return {
    signal: ctrl.signal,
    clearTimer,
    detach: () => {
      clearTimer();
      caller?.removeEventListener('abort', onAbort);
    },
  };
}

export interface StreamResult {
  stream: ReadableStream<Uint8Array>;
  /** Known as soon as a provider accepts the request; cost fills in at the end. */
  trace: MeshTrace;
}

export class InferenceMesh {
  readonly registry: Registry;
  readonly ledger: QuotaLedger;
  readonly health: HealthTracker;
  private readonly router: Router;
  private readonly adapters: Record<string, Adapter>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly onEvent: (e: MeshEvent) => void;

  constructor(opts: MeshOptions) {
    this.registry = opts.registry;
    this.ledger = opts.ledger ?? new QuotaLedger();
    this.health = opts.health ?? new HealthTracker();
    this.router = new Router(this.registry, { health: this.health });
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.onEvent = opts.onEvent ?? (() => {});
    this.adapters = opts.adapters ?? {
      'openai-compat': new OpenAICompatAdapter(),
      'workers-ai': new OpenAICompatAdapter(),
      gemini: new GeminiAdapter(),
    };
  }

  private routeFor(req: ChatRequest): RouteRequest {
    const parsed = parseModel(req.model);
    return { ...parsed, ...(req.mesh ?? {}), ...(parsed.mesh ? { mesh: parsed.mesh } : {}) };
  }

  async chat(req: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.run(req, signal, false) as Promise<ChatResponse>;
  }

  async stream(req: ChatRequest, signal?: AbortSignal): Promise<StreamResult> {
    return this.run(req, signal, true) as Promise<StreamResult>;
  }

  private async run(
    req: ChatRequest,
    signal: AbortSignal | undefined,
    streaming: boolean,
  ): Promise<ChatResponse | StreamResult> {
    const routeReq = this.routeFor(req);
    const decision = this.router.route(routeReq);
    this.onEvent({ type: 'route', profile: decision.profile.name });

    if (decision.ranked.length === 0) {
      throw new NoCandidateError(
        `no provider satisfies this request (profile '${decision.profile.name}'). ` +
          `${this.registry.candidates.length} candidates in registry, all rejected.`,
        decision.rejected,
      );
    }

    const estimated = routeReq.estimatedTokens ?? estimateTokens(req);
    const attempts: MeshTrace['attempts'] = [];
    const started = Date.now();

    for (const scored of decision.ranked.slice(0, this.maxAttempts)) {
      const { candidate } = scored;
      const key = candidate.key;

      const admitted = await this.ledger.admit(key, candidate.model.quota, estimated);
      if (!admitted.ok) {
        attempts.push({ key, error: `quota: ${admitted.reason}`, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: admitted.reason ?? 'quota' });
        continue;
      }

      const adapter = this.adapters[candidate.provider.kind];
      if (!adapter) {
        await this.ledger.refund(key);
        attempts.push({ key, error: `no adapter for kind '${candidate.provider.kind}'`, ms: 0 });
        continue;
      }

      const attempt = combineSignals(this.timeoutMs, signal);
      const t0 = Date.now();
      this.onEvent({ type: 'attempt', key, profile: decision.profile.name });

      try {
        const ctx = {
          candidate,
          apiKey: this.registry.apiKey(candidate.provider.id),
          ...(this.registry.accountId(candidate.provider.id)
            ? { accountId: this.registry.accountId(candidate.provider.id) as string }
            : {}),
          request: req,
          signal: attempt.signal,
          fetchImpl: this.fetchImpl,
        };

        if (streaming) {
          const raw = await adapter.stream(ctx);
          const ms = Date.now() - t0;
          // Headers are in. From here the timeout must not apply.
          attempt.clearTimer();
          this.health.success(key, ms);
          const trace: MeshTrace = {
            served_by: key,
            profile: decision.profile.name,
            attempts,
            latency_ms: ms,
            cost_usd: 0,
          };
          this.onEvent({ type: 'success', key, ms });
          // Full teardown is deferred to stream end so the caller can still
          // abort a completion that is already flowing.
          return { stream: this.meter(raw, candidate, trace, attempt.detach), trace };
        }

        const res = await adapter.chat(ctx);
        const ms = Date.now() - t0;
        attempt.detach();
        this.health.success(key, ms);
        const usage = res.usage;
        const cost = usage
          ? costOf(candidate.model, usage.prompt_tokens, usage.completion_tokens)
          : 0;
        if (usage) await this.ledger.record(key, usage.total_tokens);
        await this.ledger.flush();
        this.onEvent({ type: 'success', key, ms, costUsd: cost, ...(usage ? { usage } : {}) });
        return {
          ...res,
          mesh: {
            served_by: key,
            profile: decision.profile.name,
            attempts,
            latency_ms: Date.now() - started,
            cost_usd: cost,
          },
        };
      } catch (err) {
        attempt.detach();
        const ms = Date.now() - t0;
        await this.ledger.refund(key);
        const pe = err instanceof ProviderError ? err : undefined;
        this.health.failure(key, pe?.retryAfterMs);
        const message = err instanceof Error ? err.message : String(err);
        attempts.push({ key, ...(pe ? { status: pe.status } : {}), error: message, ms });
        this.onEvent({ type: 'failure', key, ...(pe ? { status: pe.status } : {}), error: message, ms });

        // A malformed request fails identically everywhere. Walking the chain
        // would turn one clear 400 into four confusing ones.
        if (pe && !pe.failoverable) {
          await this.ledger.flush();
          throw new MeshError(message, pe.status, 'provider_error', { attempts });
        }
      }
    }

    await this.ledger.flush();
    this.onEvent({ type: 'exhausted', profile: decision.profile.name });
    throw new MeshError(
      `all ${attempts.length} attempt(s) failed: ` +
        attempts.map((a) => `${a.key} (${a.status ?? '-'}: ${a.error})`).join('; '),
      503,
      'all_providers_failed',
      { attempts, rejected: decision.rejected },
    );
  }

  /**
   * Wrap a provider stream so usage lands in the ledger.
   *
   * Fallback is impossible past this point: bytes are already on their way to
   * the client. An error here ends the stream, it does not retry.
   */
  private meter(
    stream: ReadableStream<Uint8Array>,
    candidate: { key: string; model: { price: { inPerMTok: number; outPerMTok: number } } },
    trace: MeshTrace,
    done: () => void,
  ): ReadableStream<Uint8Array> {
    const decoder = new TextDecoder();
    const ledger = this.ledger;
    const onEvent = this.onEvent;
    const model = candidate.model as unknown as Parameters<typeof costOf>[0];
    let tail = '';
    let usage: Usage | undefined;

    return stream.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          // Only the last few KB can hold the usage chunk; keep the window small
          // so a long completion does not accumulate in memory.
          tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
        },
        async flush() {
          for (const line of tail.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload) as { usage?: Usage };
              if (parsed.usage) usage = parsed.usage;
            } catch {
              /* partial JSON in the tail window; the next line may still parse */
            }
          }
          if (usage) {
            trace.cost_usd = costOf(model, usage.prompt_tokens, usage.completion_tokens);
            await ledger.record(candidate.key, usage.total_tokens);
          }
          await ledger.flush();
          onEvent({
            type: 'success',
            key: candidate.key,
            costUsd: trace.cost_usd,
            ...(usage ? { usage } : {}),
          });
          done();
        },
      }),
    );
  }
}
