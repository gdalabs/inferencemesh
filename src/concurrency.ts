/**
 * Per-provider concurrency limits.
 *
 * The quota ledger counts requests per minute and per day. Neither answers the
 * question a coding agent asks by fanning out: *how many of my requests are in
 * flight right now?* A provider that allows one concurrent request is well
 * inside its rpm budget while returning a burst of 429s, because the limit it
 * enforces is not the one being counted.
 *
 * Measured on 2026-08-16: the same agent task ran 6 attempts with 3 failures
 * against a single provider, and 3 attempts with 0 failures once a second
 * provider was available. More candidates hide the problem. A semaphore fixes
 * it.
 *
 * Scope is the **provider**, not the candidate. Concurrency is a property of
 * the credential, not of the model: two models behind one API key share the
 * account's slots, and a request rejected for concurrency occupies one whether
 * or not it names the same model. Keying on `provider/model` would let a
 * two-model provider run twice its limit.
 *
 * A provider with no `maxConcurrent` is unlimited and costs nothing here — the
 * limiter never allocates for it. Limits are configured, never guessed: this
 * module supplies the mechanism, and a number that nobody has observed is the
 * same kind of lie as an unverified price.
 */

/** A held slot. `release` is idempotent; calling it twice is a no-op. */
export interface Slot {
  release(): void;
}

const UNLIMITED: Slot = { release() {} };

interface Waiter {
  resolve: (slot: Slot) => void;
  reject: (err: Error) => void;
  settled: boolean;
  cleanup: () => void;
}

export class ConcurrencyLimitError extends Error {
  constructor(
    readonly providerId: string,
    readonly limit: number,
    message: string,
  ) {
    super(message);
    this.name = 'ConcurrencyLimitError';
  }
}

export interface AcquireOptions {
  /** How long to wait for a slot before giving up. */
  timeoutMs: number;
  /** Caller abort. Rejects the wait with the caller's reason. */
  signal?: AbortSignal;
}

export class ConcurrencyLimiter {
  private readonly held = new Map<string, number>();
  private readonly queue = new Map<string, Waiter[]>();

  /** How many requests this limiter believes are in flight for `providerId`. */
  inFlight(providerId: string): number {
    return this.held.get(providerId) ?? 0;
  }

  /** How many callers are queued behind a full provider. */
  waiting(providerId: string): number {
    return this.queue.get(providerId)?.length ?? 0;
  }

  /**
   * Take a slot if one is free right now. Returns null when the provider is
   * saturated — the caller is expected to try somebody else, which is the
   * entire reason this router exists.
   */
  tryAcquire(providerId: string, limit: number | undefined): Slot | null {
    if (limit === undefined) return UNLIMITED;
    const n = this.inFlight(providerId);
    // A queue that is already forming takes precedence, or a steady stream of
    // new arrivals would step over everyone waiting.
    if (n >= limit || this.waiting(providerId) > 0) return null;
    this.held.set(providerId, n + 1);
    return this.slotFor(providerId);
  }

  /**
   * Wait for a slot, FIFO.
   *
   * Only worth doing when there is nowhere else to go: waiting on a saturated
   * provider while a free one sits in the chain is exactly the mistake this
   * router exists to avoid.
   */
  acquire(providerId: string, limit: number | undefined, opts: AcquireOptions): Promise<Slot> {
    const immediate = this.tryAcquire(providerId, limit);
    if (immediate) return Promise.resolve(immediate);

    return new Promise<Slot>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        settled: false,
        cleanup: () => {},
      };

      const settle = (fn: () => void) => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.cleanup();
        this.drop(providerId, waiter);
        fn();
      };

      const timer = setTimeout(() => {
        settle(() =>
          reject(
            new ConcurrencyLimitError(
              providerId,
              limit as number,
              `provider '${providerId}' held ${limit} concurrent request(s) for ` +
                `${opts.timeoutMs}ms with no slot freed`,
            ),
          ),
        );
      }, opts.timeoutMs);

      const onAbort = () => settle(() => reject(asError(opts.signal?.reason)));

      waiter.cleanup = () => {
        clearTimeout(timer);
        opts.signal?.removeEventListener('abort', onAbort);
      };

      if (opts.signal) {
        if (opts.signal.aborted) {
          settle(() => reject(asError(opts.signal?.reason)));
          return;
        }
        opts.signal.addEventListener('abort', onAbort, { once: true });
      }

      const q = this.queue.get(providerId);
      if (q) q.push(waiter);
      else this.queue.set(providerId, [waiter]);
    });
  }

  private slotFor(providerId: string): Slot {
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this.handOff(providerId);
      },
    };
  }

  /**
   * Give the freed slot straight to the next waiter rather than decrementing
   * and letting everyone race for it. Without the direct hand-off a burst of
   * arrivals can starve whoever queued first.
   */
  private handOff(providerId: string): void {
    const q = this.queue.get(providerId);
    while (q && q.length > 0) {
      const next = q.shift() as Waiter;
      if (q.length === 0) this.queue.delete(providerId);
      if (next.settled) continue;
      next.settled = true;
      next.cleanup();
      next.resolve(this.slotFor(providerId));
      return;
    }
    const n = this.inFlight(providerId);
    if (n <= 1) this.held.delete(providerId);
    else this.held.set(providerId, n - 1);
  }

  private drop(providerId: string, waiter: Waiter): void {
    const q = this.queue.get(providerId);
    if (!q) return;
    const i = q.indexOf(waiter);
    if (i !== -1) q.splice(i, 1);
    if (q.length === 0) this.queue.delete(providerId);
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason ?? 'aborted'));
}
