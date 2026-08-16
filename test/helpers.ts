import type { ProviderConfig } from '../src/types.js';
import type { FetchLike } from '../src/providers/base.js';

/** Two free providers and one paid one, enough to exercise every filter. */
export function fixtureProviders(): ProviderConfig[] {
  return [
    {
      id: 'alpha',
      kind: 'openai-compat',
      baseUrl: 'https://alpha.test/v1',
      apiKeyEnv: 'ALPHA_KEY',
      maxPrivacy: 'internal',
      models: [
        {
          id: 'alpha-free',
          capabilities: ['text', 'code'],
          contextWindow: 8000,
          price: { inPerMTok: 0, outPerMTok: 0 },
          quality: 0.5,
          languages: { en: 0.9, ja: 0.4 },
          quota: { requestsPerMinute: 2, requestsPerDay: 3 },
        },
      ],
    },
    {
      id: 'beta',
      kind: 'openai-compat',
      baseUrl: 'https://beta.test/v1',
      apiKeyEnv: 'BETA_KEY',
      maxPrivacy: 'internal',
      models: [
        {
          id: 'beta-free',
          capabilities: ['text', 'code', 'vision'],
          contextWindow: 200000,
          price: { inPerMTok: 0, outPerMTok: 0 },
          quality: 0.5,
          languages: { en: 0.7, ja: 0.95 },
        },
      ],
    },
    {
      id: 'keyless',
      kind: 'openai-compat',
      baseUrl: 'https://keyless.test/v1',
      apiKeyEnv: 'KEYLESS_KEY',
      apiKeyOptional: true,
      maxPrivacy: 'public',
      models: [
        {
          id: 'open-tier',
          capabilities: ['text'],
          contextWindow: 8000,
          price: { inPerMTok: 0, outPerMTok: 0 },
          quality: 0.3,
          languages: { en: 0.7, ja: 0.5 },
        },
      ],
    },
    {
      id: 'paid',
      kind: 'openai-compat',
      baseUrl: 'https://paid.test/v1',
      apiKeyEnv: 'PAID_KEY',
      maxPrivacy: 'highly_confidential',
      models: [
        {
          id: 'paid-pro',
          capabilities: ['text', 'code'],
          contextWindow: 400000,
          price: { inPerMTok: 3, outPerMTok: 15 },
          quality: 0.95,
          priceVerifiedAt: '2026-08-16',
          languages: { en: 0.98, ja: 0.95 },
        },
      ],
    },
  ];
}

export const FIXTURE_ENV = {
  ALPHA_KEY: 'k-alpha',
  BETA_KEY: 'k-beta',
  PAID_KEY: 'k-paid',
};

export interface FakeCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

export type Responder = (call: FakeCall, n: number) => Response | Promise<Response>;

/** Records every call and replies from a scripted responder. */
export function fakeFetch(responder: Responder): { fetch: FetchLike; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const call: FakeCall = {
      url: input,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
      headers,
    };
    calls.push(call);
    return responder(call, calls.length);
  };
  return { fetch: fetchImpl, calls };
}

export function okChat(content: string, tokens = { prompt: 10, completion: 5 }): Response {
  return new Response(
    JSON.stringify({
      id: 'x',
      object: 'chat.completion',
      created: 0,
      model: 'whatever',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: tokens.prompt,
        completion_tokens: tokens.completion,
        total_tokens: tokens.prompt + tokens.completion,
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

export function errorResponse(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: { message } }), { status, headers });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

/** A controllable clock, so quota windows and breakers are testable. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
    set: (v: number) => {
      t = v;
    },
  };
}
