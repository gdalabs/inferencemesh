/**
 * Quota ledger.
 *
 * Free tiers are the whole reason this router exists, and free tiers are
 * rate-limited. The ledger answers two questions:
 *
 *   admit(key, quota)  — may I send this request right now?
 *   record(key, usage) — book what it actually cost.
 *
 * It is deliberately optimistic: it books a request at admission time so that
 * concurrent callers cannot both slip through the last slot, and refunds on a
 * failed attempt. That trades a small amount of unused quota for never being
 * the reason a provider 429s.
 *
 * Storage is pluggable so the same logic runs against an in-process Map, a
 * JSON file, or Workers KV / Durable Objects.
 */

import type { Quota } from './types.js';

export interface LedgerRecord {
  /** Epoch-ms timestamps of recent requests, used for the rolling minute. */
  recent: number[];
  /** UTC day key, 'YYYY-MM-DD'. */
  day: string;
  dayRequests: number;
  dayTokens: number;
}

export interface LedgerStorage {
  load(): Promise<Record<string, LedgerRecord>>;
  save(state: Record<string, LedgerRecord>): Promise<void>;
}

export class MemoryStorage implements LedgerStorage {
  private state: Record<string, LedgerRecord> = {};
  async load(): Promise<Record<string, LedgerRecord>> {
    return this.state;
  }
  async save(state: Record<string, LedgerRecord>): Promise<void> {
    this.state = state;
  }
}

export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export interface AdmitResult {
  ok: boolean;
  /** Populated when ok === false. */
  reason?: string;
}

export class QuotaLedger {
  private state: Record<string, LedgerRecord> | null = null;
  private loading: Promise<Record<string, LedgerRecord>> | null = null;
  private dirty = false;

  constructor(
    private readonly storage: LedgerStorage = new MemoryStorage(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * The state, loaded once.
   *
   * The load has to be memoised as a *promise*, not just as its result. Any
   * real storage — a file, KV — returns a fresh object per call, so two
   * requests arriving before the first load resolves each got their own copy,
   * and the second overwrote the first: reservations vanished and the limits
   * were not applied to either. Measured with a 5ms storage: three requests
   * against `requestsPerMinute: 2` were all admitted and one was booked.
   *
   * That is a cold start plus a fan-out, which is the ordinary way this gets
   * used, and it defeats the one thing admission-time booking exists for.
   */
  private async ensure(): Promise<Record<string, LedgerRecord>> {
    if (this.state !== null) return this.state;
    if (this.loading === null) {
      this.loading = this.storage.load().then((loaded) => {
        // Still null unless another path beat us here; never discard a state
        // that has already taken bookings.
        this.state ??= loaded;
        this.loading = null;
        return this.state;
      });
    }
    return this.loading;
  }

  private entry(state: Record<string, LedgerRecord>, key: string, now: number): LedgerRecord {
    const day = utcDayKey(now);
    let rec = state[key];
    if (!rec) {
      rec = { recent: [], day, dayRequests: 0, dayTokens: 0 };
      state[key] = rec;
    }
    if (rec.day !== day) {
      // New UTC day: daily counters reset, the rolling minute does not.
      rec.day = day;
      rec.dayRequests = 0;
      rec.dayTokens = 0;
    }
    rec.recent = rec.recent.filter((t) => now - t < 60_000);
    return rec;
  }

  /**
   * Reserve one request against `quota`. Returns ok:false with a reason when a
   * limit would be exceeded; in that case nothing is booked.
   *
   * `estimatedTokens` is checked against the daily token cap. Passing 0 means
   * "unknown", which admits the request — a token cap can only be enforced
   * against an estimate the caller is willing to make.
   */
  async admit(key: string, quota: Quota | undefined, estimatedTokens = 0): Promise<AdmitResult> {
    const now = this.now();
    const state = await this.ensure();
    const rec = this.entry(state, key, now);

    if (quota) {
      if (quota.requestsPerMinute !== undefined && rec.recent.length >= quota.requestsPerMinute) {
        return { ok: false, reason: `rpm ${rec.recent.length}/${quota.requestsPerMinute}` };
      }
      if (quota.requestsPerDay !== undefined && rec.dayRequests >= quota.requestsPerDay) {
        return { ok: false, reason: `rpd ${rec.dayRequests}/${quota.requestsPerDay}` };
      }
      if (
        quota.tokensPerDay !== undefined &&
        rec.dayTokens + estimatedTokens > quota.tokensPerDay
      ) {
        return { ok: false, reason: `tpd ${rec.dayTokens}/${quota.tokensPerDay}` };
      }
    }

    rec.recent.push(now);
    rec.dayRequests += 1;
    this.dirty = true;
    return { ok: true };
  }

  /** Give back a reservation whose attempt never reached the provider. */
  async refund(key: string): Promise<void> {
    const state = await this.ensure();
    const rec = state[key];
    if (!rec) return;
    rec.recent.pop();
    rec.dayRequests = Math.max(0, rec.dayRequests - 1);
    this.dirty = true;
  }

  /** Book real token usage after a successful call. */
  async record(key: string, totalTokens: number): Promise<void> {
    const now = this.now();
    const state = await this.ensure();
    const rec = this.entry(state, key, now);
    rec.dayTokens += totalTokens;
    this.dirty = true;
  }

  async snapshot(): Promise<Record<string, LedgerRecord>> {
    const state = await this.ensure();
    return JSON.parse(JSON.stringify(state)) as Record<string, LedgerRecord>;
  }

  /** Persist if anything changed. Cheap to call after every request. */
  async flush(): Promise<void> {
    if (!this.dirty || this.state === null) return;
    await this.storage.save(this.state);
    this.dirty = false;
  }
}
