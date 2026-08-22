import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { QuotaLedger, MemoryStorage, utcDayKey } from '../src/ledger.js';
import { HealthTracker } from '../src/health.js';
import { fakeClock } from './helpers.js';

describe('quota ledger', () => {
  test('a per-minute cap admits N then refuses', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { requestsPerMinute: 2 };
    assert.equal((await l.admit('k', quota)).ok, true);
    assert.equal((await l.admit('k', quota)).ok, true);
    const third = await l.admit('k', quota);
    assert.equal(third.ok, false);
    assert.match(third.reason ?? '', /rpm 2\/2/);
  });

  test('the minute window rolls', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { requestsPerMinute: 1 };
    await l.admit('k', quota);
    assert.equal((await l.admit('k', quota)).ok, false);
    clock.advance(60_001);
    assert.equal((await l.admit('k', quota)).ok, true);
  });

  test('a daily cap survives the minute window rolling', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { requestsPerDay: 2 };
    await l.admit('k', quota);
    clock.advance(60_001);
    await l.admit('k', quota);
    clock.advance(60_001);
    assert.equal((await l.admit('k', quota)).ok, false);
  });

  test('daily counters reset on the UTC day boundary and only then', async () => {
    // 2026-08-16T23:59:00Z — the next day is 61s away, well past a minute window.
    const clock = fakeClock(Date.parse('2026-08-16T23:59:00Z'));
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { requestsPerDay: 1 };
    assert.equal((await l.admit('k', quota)).ok, true);
    clock.advance(30_000);
    assert.equal((await l.admit('k', quota)).ok, false, 'same UTC day');
    clock.advance(60_000 * 2);
    assert.equal(utcDayKey(clock.now()), '2026-08-17');
    assert.equal((await l.admit('k', quota)).ok, true, 'new UTC day');
  });

  test('a token cap is checked against the estimate, and 0 means unknown', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { tokensPerDay: 1000 };
    await l.admit('k', quota, 400);
    await l.record('k', 900);
    const denied = await l.admit('k', quota, 400);
    assert.equal(denied.ok, false);
    assert.match(denied.reason ?? '', /tpd 900\/1000/);
    assert.equal((await l.admit('k', quota, 0)).ok, true, 'unknown size cannot be refused');
  });

  test('a refund returns the reserved slot', async () => {
    const clock = fakeClock();
    const l = new QuotaLedger(new MemoryStorage(), clock.now);
    const quota = { requestsPerMinute: 1 };
    await l.admit('k', quota);
    await l.refund('k');
    assert.equal((await l.admit('k', quota)).ok, true);
  });

  test('a candidate with no quota is never refused', async () => {
    const l = new QuotaLedger(new MemoryStorage(), fakeClock().now);
    for (let i = 0; i < 50; i++) assert.equal((await l.admit('k', undefined)).ok, true);
  });

  test('state survives a flush/reload round trip', async () => {
    const storage = new MemoryStorage();
    const clock = fakeClock();
    const a = new QuotaLedger(storage, clock.now);
    await a.admit('k', { requestsPerDay: 1 });
    await a.flush();
    const b = new QuotaLedger(storage, clock.now);
    assert.equal((await b.admit('k', { requestsPerDay: 1 })).ok, false);
  });
});

describe('health tracker', () => {
  test('the breaker opens only at the threshold', () => {
    const clock = fakeClock();
    const h = new HealthTracker({ failureThreshold: 3, cooldownMs: 1000 }, clock.now);
    h.failure('k');
    h.failure('k');
    assert.equal(h.isOpen('k'), false);
    h.failure('k');
    assert.equal(h.isOpen('k'), true);
  });

  test('a success resets the failure streak', () => {
    const clock = fakeClock();
    const h = new HealthTracker({ failureThreshold: 2, cooldownMs: 1000 }, clock.now);
    h.failure('k');
    h.success('k', 100);
    h.failure('k');
    assert.equal(h.isOpen('k'), false, 'the streak restarted');
  });

  test('Retry-After wins over the computed cooldown', () => {
    const clock = fakeClock();
    const h = new HealthTracker({ failureThreshold: 99, cooldownMs: 1000 }, clock.now);
    h.failure('k', 30_000);
    assert.equal(h.isOpen('k'), true, 'one failure is enough when the provider named a wait');
    clock.advance(29_000);
    assert.equal(h.isOpen('k'), true);
    clock.advance(2_000);
    assert.equal(h.isOpen('k'), false);
  });

  test('repeated opens back off, up to the cap', () => {
    const clock = fakeClock();
    const h = new HealthTracker({ failureThreshold: 1, cooldownMs: 1000, maxCooldownMs: 4000 }, clock.now);
    h.failure('k');
    assert.equal(h.openFor('k'), 1000);
    clock.advance(1001);
    h.failure('k');
    assert.equal(h.openFor('k'), 2000);
    clock.advance(2001);
    h.failure('k');
    assert.equal(h.openFor('k'), 4000);
    clock.advance(4001);
    h.failure('k');
    assert.equal(h.openFor('k'), 4000, 'capped');
  });

  test('latency is an EWMA, so one slow call does not dominate', () => {
    const h = new HealthTracker({ alpha: 0.5 }, fakeClock().now);
    h.success('k', 100);
    assert.equal(h.latencyMs('k'), 100);
    h.success('k', 300);
    assert.equal(h.latencyMs('k'), 200);
  });
});

describe('ledger — a cold start under load', () => {
  /** Storage that takes a tick and hands back a fresh object, like a file. */
  function slowStorage(initial: Record<string, unknown> = {}) {
    let saved = JSON.parse(JSON.stringify(initial)) as Record<string, never>;
    let loads = 0;
    return {
      loads: () => loads,
      async load() {
        loads++;
        await new Promise((r) => setTimeout(r, 5));
        return JSON.parse(JSON.stringify(saved)) as Record<string, never>;
      },
      async save(state: Record<string, never>) {
        saved = JSON.parse(JSON.stringify(state)) as Record<string, never>;
      },
    };
  }

  test('a burst arriving before the first load still respects the limit', async () => {
    // Measured before the fix: three admitted against rpm 2, one booked. Any
    // storage that is not the in-memory one returns a fresh object per load,
    // so the second caller overwrote the first caller's reservation. A cold
    // start plus a fan-out is the ordinary case, and it defeated the entire
    // point of booking at admission time.
    const storage = slowStorage();
    const ledger = new QuotaLedger(storage);
    const quota = { requestsPerMinute: 2 };
    const results = await Promise.all([
      ledger.admit('p/m', quota),
      ledger.admit('p/m', quota),
      ledger.admit('p/m', quota),
    ]);
    assert.equal(results.filter((r) => r.ok).length, 2);
    const snap = await ledger.snapshot();
    assert.equal(snap['p/m']?.recent.length, 2, 'and what was admitted is what was booked');
  });

  test('the load happens once, however many callers arrive first', async () => {
    const storage = slowStorage();
    const ledger = new QuotaLedger(storage);
    await Promise.all([
      ledger.admit('a', undefined),
      ledger.admit('b', undefined),
      ledger.snapshot(),
    ]);
    assert.equal(storage.loads(), 1);
  });

  test('a storage that fails once is retried, not remembered', async () => {
    // Memoising the load means memoising its failure too, unless the rejection
    // clears it: one unreadable read would otherwise be replayed to every
    // later call and the ledger would stay broken after the storage recovered.
    let attempts = 0;
    const flaky = {
      async load() {
        attempts++;
        if (attempts === 1) throw new Error('storage unavailable');
        return {} as Record<string, never>;
      },
      async save() {},
    };
    const ledger = new QuotaLedger(flaky);
    await assert.rejects(() => ledger.admit('p/m', undefined), /storage unavailable/);
    const second = await ledger.admit('p/m', { requestsPerMinute: 1 });
    assert.equal(second.ok, true);
    assert.equal(attempts, 2);
  });

  test('state already on disk is not lost by a concurrent first request', async () => {
    const storage = slowStorage({
      'p/m': { recent: [], day: '2000-01-01', dayRequests: 7, dayTokens: 0 },
    });
    const ledger = new QuotaLedger(storage);
    await Promise.all([ledger.admit('p/m', undefined), ledger.admit('p/m', undefined)]);
    const snap = await ledger.snapshot();
    // Yesterday's day key resets the daily counters; what matters is that the
    // record survived the concurrent load at all.
    assert.ok(snap['p/m']);
  });
});
