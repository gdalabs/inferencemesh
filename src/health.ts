/**
 * Per-candidate health and latency.
 *
 * A provider that is down should not be tried on every request, and a provider
 * that is slow should lose to a provider that is fast when the mesh profile
 * says latency matters. Both come from observed calls only — there is no
 * separate health-check traffic, because a synthetic ping tells you the
 * provider is up, not that your key still has quota.
 *
 * The breaker is deliberately shallow: N consecutive failures opens it for a
 * cooldown, and the first success closes it. Half-open probing is handled by
 * the router simply ranking an expired-cooldown candidate normally again.
 */

export interface HealthOptions {
  /** Consecutive failures that open the breaker. */
  failureThreshold?: number;
  /** How long the breaker stays open, ms. Doubles per re-open, capped. */
  cooldownMs?: number;
  maxCooldownMs?: number;
  /** Weight of the newest sample in the latency EWMA, 0..1. */
  alpha?: number;
}

interface HealthRecord {
  consecutiveFailures: number;
  openUntil: number;
  openCount: number;
  /** Exponentially weighted mean latency, ms. Null until the first sample. */
  ewmaMs: number | null;
  attempts: number;
  successes: number;
}

export class HealthTracker {
  private readonly records = new Map<string, HealthRecord>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;
  private readonly alpha: number;

  constructor(
    opts: HealthOptions = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.cooldownMs = opts.cooldownMs ?? 30_000;
    this.maxCooldownMs = opts.maxCooldownMs ?? 10 * 60_000;
    this.alpha = opts.alpha ?? 0.3;
  }

  private rec(key: string): HealthRecord {
    let r = this.records.get(key);
    if (!r) {
      r = { consecutiveFailures: 0, openUntil: 0, openCount: 0, ewmaMs: null, attempts: 0, successes: 0 };
      this.records.set(key, r);
    }
    return r;
  }

  isOpen(key: string): boolean {
    return this.rec(key).openUntil > this.now();
  }

  /** ms until the breaker closes, 0 when closed. */
  openFor(key: string): number {
    return Math.max(0, this.rec(key).openUntil - this.now());
  }

  latencyMs(key: string): number | null {
    return this.rec(key).ewmaMs;
  }

  /** How many times this candidate has been tried. 0 means never measured. */
  attempts(key: string): number {
    return this.rec(key).attempts;
  }

  /**
   * Observed success rate, or null when never tried.
   *
   * This matters far more once a registry is generated rather than curated: if
   * every model carries the same neutral quality score, "does it actually
   * answer" is most of what is left to rank on.
   */
  successRate(key: string): number | null {
    const r = this.rec(key);
    return r.attempts === 0 ? null : r.successes / r.attempts;
  }

  success(key: string, latencyMs: number): void {
    const r = this.rec(key);
    r.attempts += 1;
    r.successes += 1;
    r.consecutiveFailures = 0;
    r.openUntil = 0;
    r.openCount = 0;
    r.ewmaMs = r.ewmaMs === null ? latencyMs : this.alpha * latencyMs + (1 - this.alpha) * r.ewmaMs;
  }

  /**
   * Record a failed attempt.
   *
   * `retryAfterMs` comes from a Retry-After header and, when present, wins over
   * the computed cooldown: the provider has told us exactly how long to wait,
   * and guessing shorter just burns the next request.
   */
  failure(key: string, retryAfterMs?: number): void {
    const r = this.rec(key);
    r.attempts += 1;
    r.consecutiveFailures += 1;
    if (retryAfterMs !== undefined && retryAfterMs > 0) {
      r.openUntil = Math.max(r.openUntil, this.now() + retryAfterMs);
      return;
    }
    if (r.consecutiveFailures >= this.failureThreshold) {
      const backoff = Math.min(this.cooldownMs * 2 ** r.openCount, this.maxCooldownMs);
      r.openUntil = this.now() + backoff;
      r.openCount += 1;
      r.consecutiveFailures = 0;
    }
  }

  snapshot(): Record<
    string,
    { open: boolean; openForMs: number; ewmaMs: number | null; attempts: number; successRate: number | null }
  > {
    const out: Record<
      string,
      { open: boolean; openForMs: number; ewmaMs: number | null; attempts: number; successRate: number | null }
    > = {};
    for (const [key] of this.records) {
      out[key] = {
        open: this.isOpen(key),
        openForMs: this.openFor(key),
        ewmaMs: this.latencyMs(key),
        attempts: this.attempts(key),
        successRate: this.successRate(key),
      };
    }
    return out;
  }
}
