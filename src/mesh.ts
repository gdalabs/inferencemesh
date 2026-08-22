/**
 * The mesh: route, attempt, fall back, book.
 *
 * This is the only object that sees the whole picture, and therefore the only
 * one allowed to retry. Adapters fail once and say why; the mesh decides
 * whether "why" is worth trying somebody else for.
 */

import { ConcurrencyLimiter, type Slot } from './concurrency.js';
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
  type RouteDecision,
  type RouteRequest,
  type ScoredCandidate,
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
  limiter?: ConcurrencyLimiter;
  fetchImpl?: FetchLike;
  adapters?: Record<string, Adapter>;
  /** Per-attempt timeout. The whole chain can take up to attempts × this. */
  timeoutMs?: number;
  /** Cap on how far down the ranked chain to walk. */
  maxAttempts?: number;
  /**
   * How long to queue behind a saturated provider, but only once every
   * candidate is saturated. Zero disables queueing: the request fails rather
   * than waits.
   */
  concurrencyWaitMs?: number;
  onEvent?: (e: MeshEvent) => void;
}

/**
 * Cheap token estimate for quota admission only.
 *
 * Four characters per token is an English rule. Japanese and Chinese run closer
 * to one token per character, so counting every character the same way
 * under-estimated a Japanese prompt roughly fourfold — and the error runs in
 * the dangerous direction: a daily token cap admits four times what it should
 * and the over-spend shows up as the provider cutting you off, which is the one
 * thing this ledger exists to avoid. (The comment here used to claim the
 * opposite, that being off cost an early cutoff. For English it would have.)
 *
 * So ASCII is counted at 4 characters per token and everything else at 1. That
 * over-estimates Cyrillic and Greek by roughly 2x, which is the harmless
 * direction: it reserves a little too much of a daily allowance rather than
 * spending one that is already gone. Real usage is booked from the provider's
 * own count once the call returns, so this only ever gates admission.
 */
export function estimateTokens(req: ChatRequest): number {
  let tokens = 0;
  const count = (text: string) => {
    let ascii = 0;
    for (const ch of text) {
      if ((ch.codePointAt(0) ?? 0) < 128) ascii++;
      else tokens += 1;
    }
    tokens += Math.ceil(ascii / 4);
  };
  for (const m of req.messages) {
    if (typeof m.content === 'string') count(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) if (p.type === 'text') count(p.text);
    }
  }
  return tokens + (req.max_tokens ?? 512);
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

/** Everything one attempt needs, threaded through the chain unchanged. */
interface AttemptContext {
  req: ChatRequest;
  signal: AbortSignal | undefined;
  streaming: boolean;
  decision: RouteDecision;
  estimated: number;
  attempts: MeshTrace['attempts'];
  started: number;
  /**
   * True once any candidate has actually been handed to a provider.
   *
   * Distinguishes "everything was busy" from "something was tried and failed",
   * which is the difference between queueing being the only way forward and
   * queueing being added latency on a request that already had its shot.
   */
  reached: boolean;
}

export class InferenceMesh {
  private _registry: Registry;
  readonly ledger: QuotaLedger;
  readonly health: HealthTracker;
  readonly limits: ConcurrencyLimiter;
  private _router: Router;
  private readonly adapters: Record<string, Adapter>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly concurrencyWaitMs: number;
  private readonly onEvent: (e: MeshEvent) => void;

  constructor(opts: MeshOptions) {
    this._registry = opts.registry;
    this.ledger = opts.ledger ?? new QuotaLedger();
    this.health = opts.health ?? new HealthTracker();
    this.limits = opts.limiter ?? new ConcurrencyLimiter();
    this._router = new Router(this._registry, { health: this.health });
    this.fetchImpl = opts.fetchImpl ?? ((input, init) => fetch(input, init));
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.maxAttempts = opts.maxAttempts ?? 4;
    this.concurrencyWaitMs = opts.concurrencyWaitMs ?? 30_000;
    this.onEvent = opts.onEvent ?? (() => {});
    this.adapters = opts.adapters ?? {
      'openai-compat': new OpenAICompatAdapter(),
      'workers-ai': new OpenAICompatAdapter(),
      gemini: new GeminiAdapter(),
    };
  }

  get registry(): Registry {
    return this._registry;
  }

  private get router(): Router {
    return this._router;
  }

  /**
   * Swap in a freshly loaded registry without restarting.
   *
   * Needed because keys arrive *after* the process starts — someone adds one
   * through the setup UI and expects it to work now, not after they figure out
   * how to restart a container. Health and quota carry over deliberately: a
   * provider that was rate limited a second ago is still rate limited, and
   * forgetting that on every key addition would walk straight into a 429.
   */
  reload(registry: Registry): void {
    this._registry = registry;
    this._router = new Router(registry, { health: this.health });
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

    const ctx: AttemptContext = {
      req,
      signal,
      streaming,
      decision,
      estimated: routeReq.estimatedTokens ?? estimateTokens(req),
      attempts: [],
      started: Date.now(),
      reached: false,
    };
    const saturated: ScoredCandidate[] = [];

    for (const scored of decision.ranked.slice(0, this.maxAttempts)) {
      const { provider, key } = scored.candidate;
      // A busy provider is a reason to try somebody else, not a reason to wait.
      // Queueing here would spend the fallback chain's whole point on patience.
      const slot = this.limits.tryAcquire(provider.id, provider.maxConcurrent);
      if (!slot) {
        saturated.push(scored);
        const reason = `concurrency: ${this.limits.inFlight(provider.id)}/${provider.maxConcurrent} in flight`;
        ctx.attempts.push({ key, error: reason, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: reason });
        continue;
      }
      const answer = await this.attemptOne(scored, slot, ctx);
      if (answer) return answer;
    }

    // Nothing in the chain was ever handed to a provider, and concurrency is
    // why. There is no faster answer to fall over to, so queue for the
    // best-ranked busy one instead of returning a 503 that a moment's patience
    // would have avoided. This is the single-provider case the semaphore is
    // for; with two providers the loop above has already taken the free one.
    const head = saturated[0];
    if (head && !ctx.reached && this.concurrencyWaitMs > 0) {
      const { provider, key } = head.candidate;
      try {
        const slot = await this.limits.acquire(provider.id, provider.maxConcurrent, {
          timeoutMs: this.concurrencyWaitMs,
          ...(signal ? { signal } : {}),
        });
        const answer = await this.attemptOne(head, slot, ctx);
        if (answer) return answer;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        ctx.attempts.push({ key, error: `concurrency: ${message}`, ms: 0 });
        this.onEvent({ type: 'failure', key, error: message });
      }
    }

    await this.ledger.flush();
    this.onEvent({ type: 'exhausted', profile: decision.profile.name });
    throw new MeshError(
      `all ${ctx.attempts.length} attempt(s) failed: ` +
        ctx.attempts.map((a) => `${a.key} (${a.status ?? '-'}: ${a.error})`).join('; '),
      503,
      'all_providers_failed',
      { attempts: ctx.attempts, rejected: decision.rejected },
    );
  }

  /**
   * One candidate, one slot, one shot.
   *
   * Returns the answer, or undefined to mean "keep walking the chain". Throws
   * only for a failure that would repeat identically everywhere.
   *
   * `slot` is owned by this method: it is released on every exit except the
   * streaming one, where the stream is still occupying the provider and the
   * release rides along to the last byte.
   */
  private async attemptOne(
    scored: ScoredCandidate,
    slot: Slot,
    ctx: AttemptContext,
  ): Promise<ChatResponse | StreamResult | undefined> {
    const { candidate } = scored;
    const key = candidate.key;
    const { attempts } = ctx;
    let handedOff = false;

    try {
      const admitted = await this.ledger.admit(key, candidate.model.quota, ctx.estimated);
      if (!admitted.ok) {
        attempts.push({ key, error: `quota: ${admitted.reason}`, ms: 0 });
        this.onEvent({ type: 'attempt', key, error: admitted.reason ?? 'quota' });
        return undefined;
      }

      const adapter = this.adapters[candidate.provider.kind];
      if (!adapter) {
        await this.ledger.refund(key);
        attempts.push({ key, error: `no adapter for kind '${candidate.provider.kind}'`, ms: 0 });
        return undefined;
      }

      const attempt = combineSignals(this.timeoutMs, ctx.signal);
      const t0 = Date.now();
      ctx.reached = true;
      this.onEvent({ type: 'attempt', key, profile: ctx.decision.profile.name });

      try {
        const adapterCtx = {
          candidate,
          apiKey: this.registry.apiKey(candidate.provider.id),
          ...(this.registry.accountId(candidate.provider.id)
            ? { accountId: this.registry.accountId(candidate.provider.id) as string }
            : {}),
          request: ctx.req,
          signal: attempt.signal,
          fetchImpl: this.fetchImpl,
        };

        if (ctx.streaming) {
          const raw = await adapter.stream(adapterCtx);
          const ms = Date.now() - t0;
          // Headers are in. From here the timeout must not apply.
          attempt.clearTimer();
          this.health.success(key, ms);
          const trace: MeshTrace = {
            served_by: key,
            profile: ctx.decision.profile.name,
            attempts,
            latency_ms: ms,
            cost_usd: 0,
          };
          this.onEvent({ type: 'success', key, ms });
          handedOff = true;
          // Full teardown is deferred to stream end so the caller can still
          // abort a completion that is already flowing.
          return {
            stream: this.meter(raw, candidate, trace, () => {
              attempt.detach();
              slot.release();
            }),
            trace,
          };
        }

        const res = await adapter.chat(adapterCtx);
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
            profile: ctx.decision.profile.name,
            attempts,
            latency_ms: Date.now() - ctx.started,
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
        return undefined;
      }
    } finally {
      if (!handedOff) slot.release();
    }
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

    const meter = new TransformStream<Uint8Array, Uint8Array>({
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
      },
    });

    /**
     * Piped by hand rather than with `pipeThrough`, so teardown has one home.
     *
     * `flush` runs only when the stream ends normally. A client that hangs up
     * mid-answer cancels the readable, which errors the writable and rejects
     * this pipe — and if teardown lived in `flush` the provider's concurrency
     * slot would then be held for the life of the process, which is the exact
     * leak the limiter exists to prevent. A transformer `cancel` would read
     * better but is not in every runtime this ships to; a settled `pipeTo` is.
     */
    stream
      .pipeTo(meter.writable)
      .catch(() => {
        /* the consumer walked away, or the provider cut the stream */
      })
      .finally(done);
    return meter.readable;
  }
}
