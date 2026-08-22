/**
 * Fetch-API gateway. One function, Request in / Response out, so the same
 * handler backs the Node server, a Cloudflare Worker, Deno, and Bun.
 *
 * Routes:
 *   POST /v1/chat/completions   OpenAI-compatible, streaming and not
 *   GET  /v1/models             the registry, as OpenAI model objects
 *   GET  /healthz               breakers, quota, and load-time warnings
 */

import { InferenceMesh } from './mesh.js';
import { Registry, blendedPrice, maxPrivacyOf } from './registry.js';
import { SETUP_HTML } from './setup-ui.js';
import { MeshError, NoCandidateError, type ChatRequest, type ProviderConfig } from './types.js';

/**
 * How the gateway persists a key it has just verified.
 *
 * Kept as an injected interface so this file never touches a filesystem and
 * still runs in a Worker — and so the only code that can read a stored key is
 * the code that wrote it. Note there is deliberately no `get`: nothing in the
 * HTTP surface can return a key back to a client, which is the one guarantee
 * the setup page makes to the person pasting it.
 */
export interface KeyStore {
  save(entries: Record<string, string>): Promise<void>;
  /** Rebuild a registry from config plus every key known so far. */
  reload(): Promise<Registry>;
  /** Raw provider config, including setup metadata the Registry drops. */
  providerConfigs(): ProviderConfig[];
}

export interface GatewayOptions {
  mesh: InferenceMesh;
  /**
   * Accepted bearer tokens. Fail-closed: an empty set rejects every request
   * rather than serving an open relay to whoever finds the port.
   */
  tokens: Set<string>;
  /** Allowed Origins for browser callers. Empty means no CORS headers at all. */
  allowedOrigins?: string[];
  /** Expose /healthz without a token. Off by default. */
  publicHealth?: boolean;
  /** Enables /setup and the key endpoints. Omit to disable setup entirely. */
  keyStore?: KeyStore;
}

function cors(origin: string | null, allowed: string[] | undefined): Record<string, string> {
  if (!allowed || allowed.length === 0 || !origin) return {};
  const ok = allowed.includes('*') || allowed.includes(origin);
  if (!ok) return {};
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-headers': 'authorization, content-type',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    vary: 'Origin',
  };
}

function json(data: unknown, status: number, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...extra },
  });
}

function errorBody(message: string, code: string, detail?: unknown): unknown {
  return { error: { message, type: code, code, ...(detail === undefined ? {} : { detail }) } };
}

/**
 * Constant-time-ish token comparison.
 *
 * Set membership leaks length through timing in principle. It is used anyway
 * because these are long random tokens behind a tailnet, and the honest note is
 * worth more than a false sense of a hand-rolled compare.
 */
function authorized(req: Request, tokens: Set<string>): boolean {
  if (tokens.size === 0) return false;
  const header = req.headers.get('authorization');
  if (!header) return false;
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return tokens.has(m[1] as string);
}

/**
 * `created` for the model list.
 *
 * The OpenAI Model object carries a creation timestamp, and the official SDKs
 * type it as required — omitting it makes a strictly-deserialising client fail
 * on a listing that is otherwise fine. Nothing here knows when a model was
 * created, and inventing a plausible date would be a fact nobody has.
 *
 * So this is the time this process loaded, stated as what it is: a stable
 * placeholder that satisfies the shape without claiming to be a creation date.
 * Stable matters — a value recomputed per request would churn in any client
 * that diffs the listing.
 */
const LISTING_CREATED = Math.floor(Date.now() / 1000);

export async function handleRequest(req: Request, opts: GatewayOptions): Promise<Response> {
  const url = new URL(req.url);
  const origin = req.headers.get('origin');
  const ch = cors(origin, opts.allowedOrigins);

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });

  if (url.pathname === '/setup' && req.method === 'GET') {
    // Served without a token on purpose. The token travels in the URL
    // fragment, and a browser never sends the fragment to the server — so
    // requiring auth for the page itself makes it impossible to ever open.
    // The page is static and holds no secrets; every endpoint it calls is
    // still authenticated.
    return new Response(SETUP_HTML, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        // Nothing external loads, so forbid it outright: a setup page that
        // handles API keys must not be able to fetch a third-party script.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
        'referrer-policy': 'no-referrer',
        ...ch,
      },
    });
  }

  const isHealth = url.pathname === '/healthz';
  if (!(isHealth && opts.publicHealth) && !authorized(req, opts.tokens)) {
    return json(errorBody('missing or invalid bearer token', 'unauthorized'), 401, ch);
  }

  if (isHealth) {
    return json(
      {
        ok: true,
        providers: opts.mesh.registry.providers.map((p) => p.id),
        candidates: opts.mesh.registry.candidates.length,
        warnings: opts.mesh.registry.warnings,
        health: opts.mesh.health.snapshot(),
        quota: await opts.mesh.ledger.snapshot(),
      },
      200,
      ch,
    );
  }

  if (url.pathname === '/v1/providers' && req.method === 'GET' && opts.keyStore) {
    const loaded = new Set(opts.mesh.registry.providers.map((p) => p.id));
    const providers = opts.keyStore.providerConfigs().map((p) => ({
      id: p.id,
      summary: p.summary,
      freeTierNote: p.freeTierNote,
      signupUrl: p.signupUrl,
      signupSteps: p.signupSteps,
      keyPrefix: p.keyPrefix,
      accountIdEnv: p.accountIdEnv,
      keyless: Boolean(p.apiKeyOptional),
      // Whether a key is present — never the key itself.
      configured: loaded.has(p.id) && !p.apiKeyOptional,
      models: p.models.length,
    }));
    return json(
      {
        providers,
        candidates: opts.mesh.registry.candidates.length,
        usable: opts.mesh.registry.providers.map((p) => p.id),
      },
      200,
      ch,
    );
  }

  if (url.pathname === '/v1/keys' && req.method === 'POST' && opts.keyStore) {
    let body: { providerId?: string; key?: string; accountId?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return json(errorBody('request body is not valid JSON', 'invalid_request'), 400, ch);
    }
    const cfg = opts.keyStore.providerConfigs().find((p) => p.id === body.providerId);
    if (!cfg || !body.key) {
      return json(errorBody('unknown providerId, or no key given', 'invalid_request'), 400, ch);
    }

    // Verify before saving. A mistyped key persists exactly as happily as a
    // working one and then fails later somewhere else.
    const env: Record<string, string> = { [cfg.apiKeyEnv]: body.key };
    if (cfg.accountIdEnv && body.accountId) env[cfg.accountIdEnv] = body.accountId;
    const probe = new Registry([cfg], { env });
    const candidate = probe.candidates[0];
    if (!candidate) {
      return json({ ok: false, why: `missing ${cfg.accountIdEnv ?? cfg.apiKeyEnv}` }, 200, ch);
    }
    const trial = new InferenceMesh({ registry: probe, maxAttempts: 1, timeoutMs: 30_000 });
    const t0 = Date.now();
    try {
      await trial.chat({
        model: candidate.key,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 1,
        temperature: 0,
      });
    } catch (err) {
      const why = (err instanceof Error ? err.message : String(err)).slice(0, 200);
      return json({ ok: false, why }, 200, ch);
    }

    await opts.keyStore.save(env);
    opts.mesh.reload(await opts.keyStore.reload());
    return json(
      { ok: true, ms: Date.now() - t0, candidates: opts.mesh.registry.candidates.length },
      200,
      ch,
    );
  }

  if (url.pathname === '/v1/models' && req.method === 'GET') {
    const profiles = Object.keys(opts.mesh.registry.profiles).map((name) => ({
      id: `mesh/${name}`,
      object: 'model',
      created: LISTING_CREATED,
      owned_by: 'inferencemesh',
      mesh: { kind: 'profile' },
    }));
    const models = opts.mesh.registry.candidates.map((c) => ({
      id: c.key,
      object: 'model',
      created: LISTING_CREATED,
      owned_by: c.provider.id,
      mesh: {
        kind: 'model',
        capabilities: c.model.capabilities,
        context_window: c.model.contextWindow,
        price_per_mtok_blended: blendedPrice(c.model),
        max_privacy: maxPrivacyOf(c),
      },
    }));
    return json({ object: 'list', data: [...profiles, ...models] }, 200, ch);
  }

  if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
    let body: ChatRequest;
    try {
      body = (await req.json()) as ChatRequest;
    } catch {
      return json(errorBody('request body is not valid JSON', 'invalid_request'), 400, ch);
    }
    if (!body || typeof body.model !== 'string' || !Array.isArray(body.messages)) {
      return json(errorBody('`model` (string) and `messages` (array) are required', 'invalid_request'), 400, ch);
    }

    try {
      if (body.stream) {
        const { stream, trace } = await opts.mesh.stream(body, req.signal);
        return new Response(stream, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            // Which provider answered, without waiting for the body to finish.
            'x-mesh-served-by': trace.served_by,
            'x-mesh-profile': trace.profile,
            ...ch,
          },
        });
      }
      const res = await opts.mesh.chat(body, req.signal);
      return json(res, 200, {
        'x-mesh-served-by': res.mesh?.served_by ?? '',
        'x-mesh-profile': res.mesh?.profile ?? '',
        ...ch,
      });
    } catch (err) {
      if (err instanceof NoCandidateError) {
        return json(errorBody(err.message, err.code, err.rejected), err.status, ch);
      }
      if (err instanceof MeshError) {
        return json(errorBody(err.message, err.code, err.detail), err.status, ch);
      }
      const message = err instanceof Error ? err.message : String(err);
      return json(errorBody(message, 'internal_error'), 500, ch);
    }
  }

  return json(errorBody(`no route for ${req.method} ${url.pathname}`, 'not_found'), 404, ch);
}
