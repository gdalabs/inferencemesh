import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { Registry } from '../src/registry.js';
import { InferenceMesh, estimateTokens, parseModel } from '../src/mesh.js';
import { QuotaLedger, MemoryStorage } from '../src/ledger.js';
import { HealthTracker } from '../src/health.js';
import { MeshError, NoCandidateError } from '../src/types.js';
import {
  FIXTURE_ENV,
  errorResponse,
  fakeClock,
  fakeFetch,
  fixtureProviders,
  okChat,
  readAll,
} from './helpers.js';

function mesh(
  responder: Parameters<typeof fakeFetch>[0],
  opts: Partial<ConstructorParameters<typeof InferenceMesh>[0]> = {},
) {
  const clock = fakeClock();
  const { fetch, calls } = fakeFetch(responder);
  const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
  const m = new InferenceMesh({
    registry,
    fetchImpl: fetch,
    ledger: new QuotaLedger(new MemoryStorage(), clock.now),
    health: new HealthTracker({}, clock.now),
    ...opts,
  });
  return { m, calls, clock, registry };
}

describe('model addressing', () => {
  test('mesh/<profile> routes, provider/model pins', () => {
    assert.deepEqual(parseModel('mesh/free'), { mesh: 'free' });
    assert.deepEqual(parseModel('groq/llama-3.3-70b'), { pin: 'groq/llama-3.3-70b' });
  });

  test('a model id containing a slash still pins correctly', () => {
    assert.deepEqual(parseModel('openrouter/deepseek/chat-v3.1:free'), {
      pin: 'openrouter/deepseek/chat-v3.1:free',
    });
  });

  test('estimateTokens counts text parts and the requested output', () => {
    const n = estimateTokens({
      model: 'mesh/free',
      messages: [
        { role: 'system', content: 'a'.repeat(40) },
        { role: 'user', content: [{ type: 'text', text: 'b'.repeat(40) }] },
      ],
      max_tokens: 100,
    });
    assert.equal(n, 20 + 100);
  });
});

describe('mesh — happy path', () => {
  test('sends the provider-native model id, not the mesh address', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    const res = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal((calls[0]?.body as { model: string }).model, 'alpha-free');
    assert.equal(calls[0]?.url, 'https://alpha.test/v1/chat/completions');
    assert.equal(res.choices[0]?.message.content, 'hi');
  });

  test('attaches the API key as a bearer token', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    await m.chat({ model: 'alpha/alpha-free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(calls[0]?.headers['authorization'], 'Bearer k-alpha');
  });

  test('a keyless provider gets no Authorization header at all', async () => {
    // `Bearer ` with an empty token is rejected as malformed by some gateways,
    // which looks identical to a bad key. Send nothing instead.
    const { m, calls } = mesh(() => okChat('hi'));
    await m.chat({ model: 'keyless/open-tier', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(calls[0]?.headers['authorization'], undefined);
    assert.equal(calls[0]?.url, 'https://keyless.test/v1/chat/completions');
  });

  test('strips the mesh extension before it reaches the provider', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    await m.chat({
      model: 'mesh/free',
      messages: [{ role: 'user', content: 'x' }],
      mesh: { language: 'ja', privacy: 'public' },
    });
    assert.equal(Object.hasOwn(calls[0]?.body as object, 'mesh'), false);
  });

  test('reports who served the request and what it cost', async () => {
    const { m } = mesh(() => okChat('hi', { prompt: 1_000_000, completion: 1_000_000 }));
    const res = await m.chat({ model: 'paid/paid-pro', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.served_by, 'paid/paid-pro');
    assert.equal(res.mesh?.cost_usd, 18, '1M in at $3 + 1M out at $15');
  });

  test('a free model costs exactly zero', async () => {
    const { m } = mesh(() => okChat('hi', { prompt: 999_999, completion: 999_999 }));
    const res = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.cost_usd, 0);
  });

  test('the mesh extension overrides routing without changing the wire body', async () => {
    const { m } = mesh(() => okChat('hi'));
    const res = await m.chat({
      model: 'mesh/free',
      messages: [{ role: 'user', content: 'x' }],
      mesh: { language: 'ja' },
    });
    assert.equal(res.mesh?.served_by, 'beta/beta-free', 'ja routing picked beta');
  });
});

describe('mesh — fallback', () => {
  test('a 429 fails over to the next provider, transparently', async () => {
    const { m, calls } = mesh((call) =>
      call.url.includes('alpha') ? errorResponse(429, 'rate limited') : okChat('from beta'),
    );
    const res = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.choices[0]?.message.content, 'from beta');
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
    assert.equal(res.mesh?.attempts.length, 1);
    assert.equal(res.mesh?.attempts[0]?.status, 429);
    assert.equal(calls.length, 2);
  });

  test('a 500 also fails over', async () => {
    const { m } = mesh((call) =>
      call.url.includes('alpha') ? errorResponse(500, 'boom') : okChat('from beta'),
    );
    const res = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
  });

  test('a 400 stops immediately — the same bad request fails everywhere', async () => {
    const { m, calls } = mesh(() => errorResponse(400, 'messages[0].role is invalid'));
    await assert.rejects(
      () => m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof MeshError);
        assert.equal(err.status, 400);
        assert.match(err.message, /role is invalid/);
        return true;
      },
    );
    assert.equal(calls.length, 1, 'no chain-walking on a client error');
  });

  test('a 401 does fail over — the next provider does not share this key', async () => {
    const { m } = mesh((call) =>
      call.url.includes('alpha') ? errorResponse(401, 'bad key') : okChat('from beta'),
    );
    const res = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(res.mesh?.served_by, 'beta/beta-free');
  });

  test('when everything fails, the error names every attempt', async () => {
    const { m } = mesh(() => errorResponse(503, 'down'));
    await assert.rejects(
      () => m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] }),
      (err: unknown) => {
        assert.ok(err instanceof MeshError);
        assert.equal(err.status, 503);
        assert.match(err.message, /alpha\/alpha-free/);
        assert.match(err.message, /beta\/beta-free/);
        return true;
      },
    );
  });

  test('maxAttempts caps how far down the chain it walks', async () => {
    const { m, calls } = mesh(() => errorResponse(503, 'down'), { maxAttempts: 1 });
    await assert.rejects(() => m.chat({ model: 'mesh/best', messages: [{ role: 'user', content: 'x' }] }));
    assert.equal(calls.length, 1);
  });

  test('Retry-After from the provider opens the breaker for exactly that long', async () => {
    const { m, clock } = mesh((call) =>
      call.url.includes('alpha')
        ? errorResponse(429, 'slow down', { 'retry-after': '120' })
        : okChat('from beta'),
    );
    await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(m.health.isOpen('alpha/alpha-free'), true);
    clock.advance(119_000);
    assert.equal(m.health.isOpen('alpha/alpha-free'), true);
    clock.advance(2_000);
    assert.equal(m.health.isOpen('alpha/alpha-free'), false);
  });

  test('an exhausted quota is skipped without spending a network call', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    // alpha allows 2 requests/minute; the third must go to beta.
    await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    const third = await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    assert.equal(third.mesh?.served_by, 'beta/beta-free');
    assert.equal(third.mesh?.attempts[0]?.error, 'quota: rpm 2/2');
    assert.equal(calls.length, 3, 'the skipped candidate cost no request');
  });

  test('a failed attempt refunds its quota reservation', async () => {
    let fail = true;
    const { m } = mesh((call) => {
      if (call.url.includes('alpha') && fail) return errorResponse(500, 'boom');
      return okChat('ok');
    });
    await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });
    fail = false;
    const snap = await m.ledger.snapshot();
    assert.equal(snap['alpha/alpha-free']?.dayRequests, 0, 'the failed reservation was returned');
  });

  test('nothing matching the filters is a 503 that lists the reasons', async () => {
    const { m } = mesh(() => okChat('hi'));
    await assert.rejects(
      () =>
        m.chat({
          model: 'mesh/free',
          messages: [{ role: 'user', content: 'x' }],
          mesh: { privacy: 'highly_confidential' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof NoCandidateError);
        assert.ok(err.rejected.some((r) => r.reason.includes('privacy')));
        return true;
      },
    );
  });
});

describe('mesh — streaming', () => {
  const sse = (lines: string[]) =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          for (const l of lines) c.enqueue(enc.encode(l));
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } },
    );

  test('an OpenAI-shaped stream passes through unchanged', async () => {
    const { m } = mesh(() =>
      sse([
        'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const { stream, trace } = await m.stream({
      model: 'mesh/free',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    const text = await readAll(stream);
    assert.match(text, /"he"/);
    assert.match(text, /\[DONE\]/);
    assert.equal(trace.served_by, 'alpha/alpha-free');
  });

  test('failover still works before the first byte', async () => {
    const { m } = mesh((call) =>
      call.url.includes('alpha')
        ? errorResponse(429, 'rate limited')
        : sse(['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', 'data: [DONE]\n\n']),
    );
    const { trace } = await m.stream({
      model: 'mesh/free',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    assert.equal(trace.served_by, 'beta/beta-free');
  });

  test('usage from the final chunk lands in the ledger and the trace', async () => {
    const { m } = mesh(() =>
      sse([
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"total_tokens":10}}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const { stream, trace } = await m.stream({
      model: 'paid/paid-pro',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    await readAll(stream);
    const snap = await m.ledger.snapshot();
    assert.equal(snap['paid/paid-pro']?.dayTokens, 10);
    assert.ok(trace.cost_usd > 0);
  });
});
