import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { ConcurrencyLimiter, ConcurrencyLimitError } from '../src/concurrency.js';
import { validateRegistryFile } from '../src/config.js';
import { configFromEnv } from '../src/server/node.js';
import { HealthTracker } from '../src/health.js';
import { QuotaLedger, MemoryStorage } from '../src/ledger.js';
import { InferenceMesh } from '../src/mesh.js';
import { Registry } from '../src/registry.js';
import { MeshError, type ProviderConfig } from '../src/types.js';
import {
  FIXTURE_ENV,
  fakeClock,
  fakeFetch,
  fixtureProviders,
  okChat,
  readAll,
} from './helpers.js';

/** Resolve on a later macrotask, so an in-flight request reaches its fetch. */
const settle = () => new Promise<void>((r) => setTimeout(r, 5));

/** A door the fake provider waits at, so a request can be held in flight. */
function gate() {
  let open!: () => void;
  const passed = new Promise<void>((r) => {
    open = r;
  });
  return { passed, open: () => open() };
}

describe('ConcurrencyLimiter', () => {
  test('an unconfigured provider is unlimited and is never tracked', () => {
    const lim = new ConcurrencyLimiter();
    for (let i = 0; i < 50; i++) assert.ok(lim.tryAcquire('p', undefined));
    assert.equal(lim.inFlight('p'), 0);
  });

  test('tryAcquire returns null at the limit and a slot again after release', () => {
    const lim = new ConcurrencyLimiter();
    const a = lim.tryAcquire('p', 2);
    const b = lim.tryAcquire('p', 2);
    assert.ok(a && b);
    assert.equal(lim.tryAcquire('p', 2), null);
    assert.equal(lim.inFlight('p'), 2);
    a.release();
    assert.equal(lim.inFlight('p'), 1);
    assert.ok(lim.tryAcquire('p', 2));
  });

  test('releasing twice does not hand out a slot that was never held', () => {
    // Without idempotence a double release under-counts in flight, and the
    // limit quietly stops being a limit.
    const lim = new ConcurrencyLimiter();
    const a = lim.tryAcquire('p', 1);
    assert.ok(a);
    a.release();
    a.release();
    assert.equal(lim.inFlight('p'), 0);
    assert.ok(lim.tryAcquire('p', 1));
    assert.equal(lim.tryAcquire('p', 1), null);
  });

  test('limits are per provider, so two providers do not share slots', () => {
    const lim = new ConcurrencyLimiter();
    assert.ok(lim.tryAcquire('p', 1));
    assert.ok(lim.tryAcquire('q', 1));
    assert.equal(lim.tryAcquire('p', 1), null);
  });

  test('a waiter is handed the freed slot, in arrival order', async () => {
    const lim = new ConcurrencyLimiter();
    const held = lim.tryAcquire('p', 1);
    assert.ok(held);

    const order: string[] = [];
    const first = lim.acquire('p', 1, { timeoutMs: 1000 }).then((s) => {
      order.push('first');
      return s;
    });
    await settle();
    const second = lim.acquire('p', 1, { timeoutMs: 1000 }).then((s) => {
      order.push('second');
      return s;
    });
    await settle();
    assert.equal(lim.waiting('p'), 2);

    held.release();
    (await first).release();
    await second;
    assert.deepEqual(order, ['first', 'second']);
  });

  test('a fresh arrival does not step over a queued waiter', async () => {
    // Otherwise a steady stream of new requests starves whoever queued first,
    // which is the failure mode a naive counter has.
    const lim = new ConcurrencyLimiter();
    const held = lim.tryAcquire('p', 1);
    assert.ok(held);
    const queued = lim.acquire('p', 1, { timeoutMs: 1000 });
    await settle();
    assert.equal(lim.tryAcquire('p', 1), null);
    held.release();
    assert.ok(await queued);
  });

  test('waiting past the timeout rejects and leaves no queue behind', async () => {
    const lim = new ConcurrencyLimiter();
    const held = lim.tryAcquire('p', 1);
    assert.ok(held);
    await assert.rejects(
      () => lim.acquire('p', 1, { timeoutMs: 20 }),
      (err: Error) => {
        assert.ok(err instanceof ConcurrencyLimitError);
        assert.match(err.message, /provider 'p' held 1 concurrent/);
        return true;
      },
    );
    assert.equal(lim.waiting('p'), 0);
    // The abandoned waiter must not still be holding a claim on the slot.
    held.release();
    assert.equal(lim.inFlight('p'), 0);
  });

  test('an aborted caller stops waiting with its own reason', async () => {
    const lim = new ConcurrencyLimiter();
    const held = lim.tryAcquire('p', 1);
    assert.ok(held);
    const ctrl = new AbortController();
    const waiting = lim.acquire('p', 1, { timeoutMs: 5000, signal: ctrl.signal });
    await settle();
    ctrl.abort(new Error('caller went away'));
    await assert.rejects(() => waiting, /caller went away/);
    assert.equal(lim.waiting('p'), 0);
    held.release();
  });

  test('an already-aborted signal never joins the queue', async () => {
    const lim = new ConcurrencyLimiter();
    const held = lim.tryAcquire('p', 1);
    assert.ok(held);
    await assert.rejects(
      () => lim.acquire('p', 1, { timeoutMs: 5000, signal: AbortSignal.abort(new Error('gone')) }),
      /gone/,
    );
    assert.equal(lim.waiting('p'), 0);
    held.release();
  });
});

describe('registry validation — maxConcurrent', () => {
  const withMax = (v: unknown) => {
    const providers = fixtureProviders();
    // Deliberately untyped: the point is to catch what a hand-edited JSON file
    // can contain, which the compiler never sees.
    const first = providers[0] as unknown as Record<string, unknown>;
    first['maxConcurrent'] = v;
    return { providers };
  };

  test('an integer >= 1 is accepted', () => {
    assert.doesNotThrow(() => validateRegistryFile(withMax(1)));
  });

  test('0 is rejected rather than silently un-routing the provider', () => {
    assert.throws(() => validateRegistryFile(withMax(0)), /invalid maxConcurrent/);
  });

  test('a fractional limit is rejected', () => {
    assert.throws(() => validateRegistryFile(withMax(1.5)), /invalid maxConcurrent/);
  });
});

describe('server config — numeric env vars', () => {
  const cfg = (env: Record<string, string>) =>
    configFromEnv({ INFERENCEMESH_TOKENS: 't', ...env } as NodeJS.ProcessEnv);

  test('an unset var takes the default', () => {
    assert.equal(cfg({}).concurrencyWaitMs, 30_000);
    assert.equal(cfg({}).port, 8910);
  });

  test('a var that is set but empty takes the default, not 0', () => {
    // `FOO=` in a .env file produces exactly this, and `Number('')` is 0 —
    // which would mean "never queue" and "listen on a random port".
    assert.equal(cfg({ INFERENCEMESH_CONCURRENCY_WAIT_MS: '' }).concurrencyWaitMs, 30_000);
    assert.equal(cfg({ INFERENCEMESH_PORT: '  ' }).port, 8910);
  });

  test('an explicit 0 is honoured', () => {
    assert.equal(cfg({ INFERENCEMESH_CONCURRENCY_WAIT_MS: '0' }).concurrencyWaitMs, 0);
  });

  test('a typo is refused rather than silently defaulted', () => {
    assert.throws(() => cfg({ INFERENCEMESH_CONCURRENCY_WAIT_MS: '30s' }), /non-negative integer/);
    assert.throws(() => cfg({ INFERENCEMESH_PORT: '-1' }), /non-negative integer/);
  });
});

/* -------------------------------------------------------------------------- */

function limited(limits: Record<string, number>): ProviderConfig[] {
  return fixtureProviders().map((p) =>
    limits[p.id] === undefined ? p : { ...p, maxConcurrent: limits[p.id] as number },
  );
}

function meshWith(
  providers: ProviderConfig[],
  responder: Parameters<typeof fakeFetch>[0],
  opts: Partial<ConstructorParameters<typeof InferenceMesh>[0]> = {},
) {
  const clock = fakeClock();
  const { fetch, calls } = fakeFetch(responder);
  const registry = new Registry(providers, { env: FIXTURE_ENV });
  const m = new InferenceMesh({
    registry,
    fetchImpl: fetch,
    ledger: new QuotaLedger(new MemoryStorage(), clock.now),
    health: new HealthTracker({}, clock.now),
    ...opts,
  });
  return { m, calls };
}

const ask = { model: 'mesh/free', messages: [{ role: 'user' as const, content: 'x' }] };

describe('mesh — per-provider concurrency', () => {
  test('a saturated provider falls over instead of collecting a 429', async () => {
    const g = gate();
    const { m, calls } = meshWith(limited({ alpha: 1 }), async (call) => {
      if (call.url.includes('alpha')) await g.passed;
      return okChat('hi');
    });

    const first = m.chat(ask);
    await settle();
    const second = await m.chat(ask);

    assert.equal(second.mesh?.served_by, 'beta/beta-free');
    assert.equal(second.mesh?.attempts[0]?.error, 'concurrency: 1/1 in flight');
    g.open();
    assert.equal((await first).mesh?.served_by, 'alpha/alpha-free');
    assert.equal(calls.length, 2);
  });

  test('the slot is returned once the answer is in, so the next request reuses it', async () => {
    // Pinned, because an unpinned repeat legitimately lands elsewhere: the
    // router scores untried candidates optimistically, so beta outranks a
    // now-measured alpha on the second call. Two, not more, because alpha's
    // fixture quota is 2 rpm and a third would fall over for that reason.
    const { m } = meshWith(limited({ alpha: 1 }), () => okChat('hi'));
    for (let i = 0; i < 2; i++) {
      const res = await m.chat({ ...ask, model: 'alpha/alpha-free' });
      assert.equal(res.mesh?.served_by, 'alpha/alpha-free');
      assert.equal(m.limits.inFlight('alpha'), 0);
    }
  });

  test('two models behind one key share the account limit', async () => {
    // The credential is what the provider counts, so keying on provider/model
    // would let a two-model provider run twice its limit.
    const providers = limited({ alpha: 1 });
    const alpha = providers[0] as ProviderConfig;
    alpha.models = [
      alpha.models[0] as (typeof alpha.models)[0],
      { ...(alpha.models[0] as (typeof alpha.models)[0]), id: 'alpha-free-2', quota: undefined },
    ];

    const g = gate();
    const { m, calls } = meshWith(providers, async (call) => {
      if (call.url.includes('alpha')) await g.passed;
      return okChat('hi');
    });

    const first = m.chat({ ...ask, model: 'alpha/alpha-free' });
    await settle();
    const second = await m.chat(ask);

    assert.notEqual(second.mesh?.served_by, 'alpha/alpha-free-2');
    assert.equal(second.mesh?.served_by, 'beta/beta-free');
    g.open();
    await first;
    assert.equal(calls.filter((c) => c.url.includes('alpha')).length, 1);
  });

  test('a failed attempt returns its slot', async () => {
    const { m } = meshWith(limited({ alpha: 1 }), (call) =>
      call.url.includes('alpha')
        ? new Response('{"error":{"message":"boom"}}', { status: 500 })
        : okChat('hi'),
    );
    const res = await m.chat(ask);
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
    assert.equal(m.limits.inFlight('alpha'), 0);
  });

  test('with nowhere left to fall over to, the request queues rather than fails', async () => {
    // The single-provider case: 503 now is worse than an answer a moment later.
    const only = limited({ alpha: 1 }).filter((p) => p.id === 'alpha');
    const g = gate();
    const { m, calls } = meshWith(only, async (call, n) => {
      if (n === 1) await g.passed;
      return okChat('hi');
    });

    const first = m.chat({ ...ask, model: 'alpha/alpha-free' });
    await settle();
    const second = m.chat({ ...ask, model: 'alpha/alpha-free' });
    await settle();
    assert.equal(calls.length, 1, 'the queued request must not have been sent yet');

    g.open();
    assert.equal((await first).mesh?.served_by, 'alpha/alpha-free');
    assert.equal((await second).mesh?.served_by, 'alpha/alpha-free');
    assert.equal(calls.length, 2);
    assert.equal(m.limits.inFlight('alpha'), 0);
  });

  test('a queue that never drains fails with the wait in the message', async () => {
    const only = limited({ alpha: 1 }).filter((p) => p.id === 'alpha');
    const g = gate();
    const { m } = meshWith(
      only,
      async (call, n) => {
        if (n === 1) await g.passed;
        return okChat('hi');
      },
      { concurrencyWaitMs: 20 },
    );

    const first = m.chat({ ...ask, model: 'alpha/alpha-free' });
    await settle();
    await assert.rejects(
      () => m.chat({ ...ask, model: 'alpha/alpha-free' }),
      (err: Error) => {
        assert.ok(err instanceof MeshError);
        assert.equal(err.status, 503);
        assert.match(err.message, /held 1 concurrent request\(s\) for 20ms/);
        return true;
      },
    );
    g.open();
    await first;
  });

  test('concurrencyWaitMs 0 refuses to queue at all', async () => {
    const only = limited({ alpha: 1 }).filter((p) => p.id === 'alpha');
    const g = gate();
    const { m, calls } = meshWith(
      only,
      async (call, n) => {
        if (n === 1) await g.passed;
        return okChat('hi');
      },
      { concurrencyWaitMs: 0 },
    );

    const first = m.chat({ ...ask, model: 'alpha/alpha-free' });
    await settle();
    await assert.rejects(
      () => m.chat({ ...ask, model: 'alpha/alpha-free' }),
      /concurrency: 1\/1 in flight/,
    );
    assert.equal(calls.length, 1);
    g.open();
    await first;
  });

  test('a stream holds its slot until the last byte', async () => {
    const sse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            c.enqueue(enc.encode('data: [DONE]\n\n'));
            c.close();
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const { m } = meshWith(limited({ alpha: 1 }), () => sse());

    const { stream, trace } = await m.stream({ ...ask, stream: true });
    assert.equal(trace.served_by, 'alpha/alpha-free');
    assert.equal(m.limits.inFlight('alpha'), 1, 'headers are in, bytes are not');
    await readAll(stream);
    // The release rides on the pipe settling, which is a turn behind the last
    // read resolving. Near enough for a provider slot, but not synchronous.
    await settle();
    assert.equal(m.limits.inFlight('alpha'), 0);
  });

  test('abandoning a stream still returns the slot', async () => {
    // flush() never runs on a cancelled stream, so release cannot live only there.
    const sse = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"a"}}]}\n\n'));
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      );
    const { m } = meshWith(limited({ alpha: 1 }), () => sse());

    const { stream } = await m.stream({ ...ask, stream: true });
    const reader = stream.getReader();
    await reader.read();
    assert.equal(m.limits.inFlight('alpha'), 1);
    await reader.cancel(new Error('client hung up'));
    await settle();
    assert.equal(m.limits.inFlight('alpha'), 0);
  });

  test('an unlimited registry behaves exactly as before', async () => {
    const g = gate();
    const { m } = meshWith(fixtureProviders(), async (call) => {
      if (call.url.includes('alpha')) await g.passed;
      return okChat('hi');
    });
    const a = m.chat(ask);
    const b = m.chat(ask);
    g.open();
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.mesh?.served_by, 'alpha/alpha-free');
    assert.equal(rb.mesh?.served_by, 'alpha/alpha-free');
  });
});
