import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { handleRequest } from '../src/gateway.js';
import { InferenceMesh } from '../src/mesh.js';
import { Registry } from '../src/registry.js';
import { QuotaLedger, MemoryStorage } from '../src/ledger.js';
import { FIXTURE_ENV, fakeClock, fakeFetch, fixtureProviders, okChat, readAll } from './helpers.js';

function gateway(tokens = new Set(['secret']), extra: Record<string, unknown> = {}) {
  const { fetch } = fakeFetch(() => okChat('hi'));
  const mesh = new InferenceMesh({
    registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
    fetchImpl: fetch,
    ledger: new QuotaLedger(new MemoryStorage(), fakeClock().now),
  });
  return (req: Request) => handleRequest(req, { mesh, tokens, ...extra });
}

const chatBody = JSON.stringify({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }] });

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

describe('gateway — auth is fail-closed', () => {
  test('no token means 401', async () => {
    const res = await gateway()(post(chatBody));
    assert.equal(res.status, 401);
  });

  test('a wrong token means 401', async () => {
    const res = await gateway()(post(chatBody, { authorization: 'Bearer nope' }));
    assert.equal(res.status, 401);
  });

  test('an empty token set rejects even a correct-looking token', async () => {
    // The whole point: a misconfigured deploy must not become an open relay.
    const res = await gateway(new Set())(post(chatBody, { authorization: 'Bearer secret' }));
    assert.equal(res.status, 401);
  });

  test('a malformed Authorization header means 401, not a crash', async () => {
    for (const h of ['secret', 'Basic secret', 'Bearer', '']) {
      const res = await gateway()(post(chatBody, { authorization: h }));
      assert.equal(res.status, 401, `header: '${h}'`);
    }
  });

  test('the correct token gets through', async () => {
    const res = await gateway()(post(chatBody, { authorization: 'Bearer secret' }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-mesh-served-by'), 'alpha/alpha-free');
  });

  test('/healthz is authenticated unless explicitly made public', async () => {
    const g = gateway();
    assert.equal((await g(new Request('http://localhost/healthz'))).status, 401);
    const open = gateway(new Set(['secret']), { publicHealth: true });
    assert.equal((await open(new Request('http://localhost/healthz'))).status, 200);
  });
});

describe('gateway — request validation', () => {
  const auth = { authorization: 'Bearer secret' };

  test('a non-JSON body is a 400 with a usable message', async () => {
    const res = await gateway()(post('{not json', auth));
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /not valid JSON/);
  });

  test('missing model or messages is a 400', async () => {
    for (const body of ['{}', '{"model":"mesh/free"}', '{"messages":[]}']) {
      const res = await gateway()(post(body, auth));
      assert.equal(res.status, 400, body);
    }
  });

  test('an unknown path is a 404, not a 500', async () => {
    const res = await gateway()(new Request('http://localhost/v1/embeddings', { headers: auth }));
    assert.equal(res.status, 404);
  });

  test('a routing dead end surfaces as 503 with the rejection reasons', async () => {
    const res = await gateway()(
      post(
        JSON.stringify({
          model: 'mesh/free',
          messages: [{ role: 'user', content: 'x' }],
          mesh: { privacy: 'highly_confidential' },
        }),
        auth,
      ),
    );
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error: { code: string; detail: Array<{ reason: string }> } };
    assert.equal(body.error.code, 'no_candidate');
    assert.ok(body.error.detail.some((d) => d.reason.includes('privacy')));
  });
});

describe('gateway — discovery', () => {
  test('/v1/models lists mesh profiles alongside concrete models', async () => {
    const res = await gateway()(
      new Request('http://localhost/v1/models', { headers: { authorization: 'Bearer secret' } }),
    );
    const body = (await res.json()) as { data: Array<{ id: string; mesh: { kind: string } }> };
    const ids = body.data.map((d) => d.id);
    assert.ok(ids.includes('mesh/free'));
    assert.ok(ids.includes('alpha/alpha-free'));
    assert.equal(body.data.find((d) => d.id === 'mesh/free')?.mesh.kind, 'profile');
  });

  test('/healthz reports the providers that were skipped at load time', async () => {
    const { fetch } = fakeFetch(() => okChat('hi'));
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: { ALPHA_KEY: 'k' } }),
      fetchImpl: fetch,
    });
    const res = await handleRequest(new Request('http://localhost/healthz'), {
      mesh,
      tokens: new Set(['secret']),
      publicHealth: true,
    });
    const body = (await res.json()) as { warnings: Array<{ providerId: string }> };
    assert.deepEqual(
      body.warnings.map((w) => w.providerId).sort(),
      ['beta', 'paid'],
    );
  });
});

describe('gateway — CORS', () => {
  test('no allowlist means no CORS headers at all', async () => {
    const res = await gateway()(post(chatBody, { authorization: 'Bearer secret', origin: 'https://evil.test' }));
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  test('an allowed origin is echoed; a disallowed one is not', async () => {
    const g = gateway(new Set(['secret']), { allowedOrigins: ['https://vps-navi.com'] });
    const ok = await g(post(chatBody, { authorization: 'Bearer secret', origin: 'https://vps-navi.com' }));
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://vps-navi.com');
    const bad = await g(post(chatBody, { authorization: 'Bearer secret', origin: 'https://evil.test' }));
    assert.equal(bad.headers.get('access-control-allow-origin'), null);
  });

  test('preflight is answered without a token', async () => {
    const g = gateway(new Set(['secret']), { allowedOrigins: ['https://vps-navi.com'] });
    const res = await g(
      new Request('http://localhost/v1/chat/completions', {
        method: 'OPTIONS',
        headers: { origin: 'https://vps-navi.com' },
      }),
    );
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://vps-navi.com');
  });
});

describe('gateway — streaming', () => {
  test('a streamed reply is served as SSE with the provider named in a header', async () => {
    const { fetch } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'));
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    const mesh = new InferenceMesh({
      registry: new Registry(fixtureProviders(), { env: FIXTURE_ENV }),
      fetchImpl: fetch,
      ledger: new QuotaLedger(new MemoryStorage(), fakeClock().now),
    });
    const res = await handleRequest(
      post(JSON.stringify({ model: 'mesh/free', messages: [{ role: 'user', content: 'x' }], stream: true }), {
        authorization: 'Bearer secret',
      }),
      { mesh, tokens: new Set(['secret']) },
    );
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(res.headers.get('x-mesh-served-by'), 'alpha/alpha-free');
    assert.match(await readAll(res.body as ReadableStream<Uint8Array>), /\[DONE\]/);
  });
});
