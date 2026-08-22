import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { SETUP_HTML } from '../src/setup-ui.js';
import { handleRequest } from '../src/gateway.js';
import { InferenceMesh } from '../src/mesh.js';
import { Registry } from '../src/registry.js';
import { QuotaLedger, MemoryStorage } from '../src/ledger.js';
import { FIXTURE_ENV, errorResponse, fakeClock, fakeFetch, fixtureProviders, okChat, readAll } from './helpers.js';

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

  test('a mistyped profile is the caller\'s 400, not the server\'s 500', async () => {
    // `mesh/fastest` instead of `mesh/fast` reached the gateway as an
    // unrecognised exception and came back 500 — which tells the caller it is
    // the server's fault, and invites any client that retries 500s to hammer a
    // request that cannot ever succeed.
    const res = await gateway()(
      post(JSON.stringify({ model: 'mesh/fastest', messages: [{ role: 'user', content: 'x' }] }), {
        authorization: 'Bearer secret',
      }),
    );
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string; code: string } };
    assert.equal(body.error.code, 'unknown_profile');
    assert.match(body.error.message, /Known: .*fast/, 'and says what it could have been');
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

  test('every listed model carries the fields an OpenAI client deserialises', async () => {
    // The official SDKs type `created` as required. Leaving it out makes a
    // strict client fail on a listing that is otherwise correct — and nothing
    // here knows when a model was created, so the value is the load time,
    // documented as a placeholder rather than dressed up as a date.
    const res = await gateway()(
      new Request('http://localhost/v1/models', { headers: { authorization: 'Bearer secret' } }),
    );
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    assert.ok(body.data.length > 0);
    for (const m of body.data) {
      assert.equal(typeof m['id'], 'string');
      assert.equal(m['object'], 'model');
      assert.equal(typeof m['created'], 'number', `${String(m['id'])} has no created`);
      assert.equal(typeof m['owned_by'], 'string');
    }
  });

  test('the listing does not churn between calls', async () => {
    const g = gateway();
    const req = () =>
      g(new Request('http://localhost/v1/models', { headers: { authorization: 'Bearer secret' } }));
    const a = (await (await req()).json()) as { data: Array<{ created: number }> };
    const b = (await (await req()).json()) as { data: Array<{ created: number }> };
    assert.equal(a.data[0]?.created, b.data[0]?.created);
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

describe('gateway — setup and keys', () => {
  const SECRET = 'sk-super-secret-value-12345';

  function withStore() {
    const { fetch } = fakeFetch(() => okChat('hi'));
    const configs = fixtureProviders();
    const saved: Record<string, string> = {};
    const mesh = new InferenceMesh({
      registry: new Registry(configs, { env: FIXTURE_ENV }),
      fetchImpl: fetch,
      ledger: new QuotaLedger(new MemoryStorage(), fakeClock().now),
    });
    const keyStore = {
      async save(entries: Record<string, string>) {
        Object.assign(saved, entries);
      },
      async reload() {
        return new Registry(configs, { env: { ...FIXTURE_ENV, ...saved } });
      },
      providerConfigs: () => configs,
    };
    return {
      saved,
      call: (req: Request) => handleRequest(req, { mesh, tokens: new Set(['secret']), keyStore }),
    };
  }

  const auth = { authorization: 'Bearer secret' };

  test('the setup page is served without a token, because a browser cannot send one', async () => {
    // The token lives in the URL fragment, which is never transmitted. Requiring
    // auth for the page itself makes it impossible to open at all.
    const res = await withStore().call(new Request('http://localhost/setup'));
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  });

  test('the endpoints the page calls are still authenticated', async () => {
    const g = withStore();
    assert.equal((await g.call(new Request('http://localhost/v1/providers'))).status, 401);
    const post = new Request('http://localhost/v1/keys', { method: 'POST', body: '{}' });
    assert.equal((await g.call(post)).status, 401);
  });

  test('/v1/providers reports whether a key exists, never the key', async () => {
    const g = withStore();
    const res = await g.call(new Request('http://localhost/v1/providers', { headers: auth }));
    const body = (await res.json()) as { providers: Array<{ id: string; configured: boolean; keyless: boolean }> };
    const alpha = body.providers.find((p) => p.id === 'alpha');
    assert.equal(alpha?.configured, true);
    assert.equal(body.providers.find((p) => p.id === 'keyless')?.keyless, true);
    // The fixture keys are in the loaded registry; none of them may appear here.
    const text = JSON.stringify(body);
    for (const v of Object.values(FIXTURE_ENV)) assert.equal(text.includes(v), false);
  });

  test('a key that does not work is rejected and never saved', async () => {
    const { fetch } = fakeFetch(() => errorResponse(401, 'invalid api key'));
    const configs = fixtureProviders();
    const saved: Record<string, string> = {};
    const mesh = new InferenceMesh({ registry: new Registry(configs, { env: FIXTURE_ENV }), fetchImpl: fetch });
    // The verification path builds its own mesh with the real fetch, so this
    // test drives it through a provider whose calls fail.
    const res = await handleRequest(
      new Request('http://localhost/v1/keys', {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: 'alpha', key: SECRET }),
      }),
      {
        mesh,
        tokens: new Set(['secret']),
        keyStore: {
          async save(e: Record<string, string>) {
            Object.assign(saved, e);
          },
          async reload() {
            return new Registry(configs, { env: FIXTURE_ENV });
          },
          providerConfigs: () => configs,
        },
      },
    );
    const body = (await res.json()) as { ok: boolean; why?: string };
    assert.equal(body.ok, false, 'a live call decides, not the shape of the string');
    assert.deepEqual(saved, {}, 'nothing was written');
    assert.equal(JSON.stringify(body).includes(SECRET), false, 'the rejected key is not echoed back');
  });

  test('nothing about a key reaches the console, on either path', async () => {
    // The README says keys are never logged and that tests enforce it. Half of
    // that was true — /v1/providers was covered — and the logging half was a
    // claim with nothing behind it. A key that reaches stdout outlives the
    // process in a journal, which is the whole reason the rule exists.
    const lines: string[] = [];
    const real = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    };
    try {
      for (const outcome of ['works', 'fails'] as const) {
        const { fetch } = fakeFetch(() =>
          outcome === 'works' ? okChat('hi') : errorResponse(401, `invalid api key ${SECRET}`),
        );
        const configs = fixtureProviders();
        const mesh = new InferenceMesh({
          registry: new Registry(configs, { env: FIXTURE_ENV }),
          fetchImpl: fetch,
        });
        await handleRequest(
          new Request('http://localhost/v1/keys', {
            method: 'POST',
            headers: { ...auth, 'content-type': 'application/json' },
            body: JSON.stringify({ providerId: 'alpha', key: SECRET }),
          }),
          {
            mesh,
            tokens: new Set(['secret']),
            keyStore: {
              async save() {},
              async reload() {
                return new Registry(configs, { env: FIXTURE_ENV });
              },
              providerConfigs: () => configs,
            },
          },
        );
      }
    } finally {
      console.log = real.log;
      console.error = real.error;
      console.warn = real.warn;
    }
    const printed = lines.join('\n');
    assert.equal(printed.includes(SECRET), false, `a key was printed: ${printed}`);
    assert.equal(printed.includes('secret'), false, 'nor the bearer token');
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

describe('the setup page is self-contained', () => {
  test('nothing is loaded from another host', () => {
    // The page is served with `default-src 'none'` precisely so it cannot
    // fetch a third-party script while handling API keys. A literal external
    // URL in the markup would be a request the CSP blocks at runtime and
    // nobody notices until the page half-works.
    const external = SETUP_HTML.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [];
    assert.deepEqual(external, []);
  });

  test('the token is read from the fragment, never from the query string', () => {
    // A query string reaches the server and every access log in between; the
    // fragment does not. This is also why /setup is served unauthenticated.
    assert.match(SETUP_HTML, /location\.hash/);
    assert.ok(!/location\.search/.test(SETUP_HTML));
  });

  test('the inline script parses', () => {
    // The page is one hand-written string. A syntax error in it produces a
    // blank page that still serves 200 with the right headers, so every test
    // about the page passes and the page does not work. `new Function` parses
    // without running, which is exactly the question being asked.
    const scripts = [...SETUP_HTML.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0, 'there is a script to check');
    for (const code of scripts) assert.doesNotThrow(() => new Function(code as string));
  });

  test('its tags are balanced', () => {
    // An orphaned closing tag ends the parent early and silently, which is how
    // half a page disappears without anything erroring.
    for (const tag of ['div', 'script', 'style', 'body', 'html', 'form']) {
      const open = (SETUP_HTML.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length;
      const close = (SETUP_HTML.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
      assert.equal(open, close, `<${tag}> opened ${open} times, closed ${close}`);
    }
  });

  test('no key is ever put in browser storage', () => {
    for (const sink of ['localStorage', 'sessionStorage', 'document.cookie']) {
      assert.ok(!SETUP_HTML.includes(sink), `${sink} must not hold a provider key`);
    }
  });
});

describe('loading the registry file', () => {
  test('a path the user chose and got wrong is an error, not a silent fallback', async () => {
    // The fallback exists so a bundled build with no JSON on disk still works.
    // Applying it to a path somebody typed answers their typo by serving a
    // different registry than the one they asked for, and nothing looks wrong.
    const { loadRegistryFile } = await import('../src/server/node.js');
    await assert.rejects(
      () => loadRegistryFile('/nonexistent/registry.json', true),
      /INFERENCEMESH_REGISTRY points at/,
    );
  });

  test('the discovered path still falls back, which is what bundles need', async () => {
    const { loadRegistryFile } = await import('../src/server/node.js');
    const raw = (await loadRegistryFile('/nonexistent/registry.json', false)) as {
      providers: unknown[];
    };
    assert.ok(Array.isArray(raw.providers) && raw.providers.length > 0);
  });

  test('no path at all is the embedded registry', async () => {
    const { loadRegistryFile } = await import('../src/server/node.js');
    const raw = (await loadRegistryFile(null)) as { providers: unknown[] };
    assert.ok(raw.providers.length > 0);
  });
});
