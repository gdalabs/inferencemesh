import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { GeminiAdapter } from '../src/providers/gemini.js';
import { parseDuration, parseRetryAfter, ProviderError } from '../src/providers/base.js';
import type { AdapterContext } from '../src/providers/base.js';
import type { ChatMessage, Candidate } from '../src/types.js';
import { fakeFetch, readAll } from './helpers.js';

const candidate = {
  key: 'gemini/gemini-2.5-flash',
  provider: {
    id: 'gemini',
    kind: 'gemini',
    baseUrl: 'https://gl.test/v1beta',
    apiKeyEnv: 'GEMINI_API_KEY',
    maxPrivacy: 'internal',
    models: [],
  },
  model: {
    id: 'gemini-2.5-flash',
    capabilities: ['text', 'vision'],
    contextWindow: 1000,
    price: { inPerMTok: 0, outPerMTok: 0 },
    quality: 0.8,
  },
} as unknown as Candidate;

function ctx(messages: ChatMessage[], fetchImpl: AdapterContext['fetchImpl'], extra = {}): AdapterContext {
  return {
    candidate,
    apiKey: 'k-gemini',
    request: { model: 'mesh/free', messages, ...extra },
    fetchImpl,
  };
}

function geminiOk(text: string): Response {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 6, totalTokenCount: 10 },
    }),
    { status: 200 },
  );
}

describe('gemini adapter — request shape', () => {
  test('system messages become systemInstruction, not a user turn', async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(
      ctx([{ role: 'system', content: 'be terse' }, { role: 'user', content: 'hello' }], fetch),
    );
    const body = calls[0]?.body as { contents: unknown[]; systemInstruction: { parts: [{ text: string }] } };
    assert.equal(body.systemInstruction.parts[0].text, 'be terse');
    assert.equal(body.contents.length, 1);
  });

  test('consecutive same-role turns are merged, which Gemini requires', async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(
      ctx(
        [
          { role: 'user', content: 'one' },
          { role: 'user', content: 'two' },
          { role: 'assistant', content: 'ack' },
        ],
        fetch,
      ),
    );
    const body = calls[0]?.body as { contents: Array<{ role: string; parts: Array<{ text: string }> }> };
    assert.equal(body.contents.length, 2);
    assert.equal(body.contents[0]?.parts.length, 2);
    assert.equal(body.contents[1]?.role, 'model', "OpenAI's 'assistant' is Gemini's 'model'");
  });

  test('OpenAI generation params are renamed, not dropped', async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(
      ctx([{ role: 'user', content: 'x' }], fetch, {
        temperature: 0.2,
        max_tokens: 64,
        top_p: 0.9,
        stop: 'END',
      }),
    );
    const cfg = (calls[0]?.body as { generationConfig: Record<string, unknown> }).generationConfig;
    assert.deepEqual(cfg, {
      temperature: 0.2,
      maxOutputTokens: 64,
      topP: 0.9,
      stopSequences: ['END'],
    });
  });

  test('the API key travels in a header, never in the query string', async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(ctx([{ role: 'user', content: 'x' }], fetch));
    assert.equal(calls[0]?.headers['x-goog-api-key'], 'k-gemini');
    assert.equal(calls[0]?.url.includes('k-gemini'), false);
  });

  test('a data: image becomes inlineData', async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(
      ctx(
        [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
            ],
          },
        ],
        fetch,
      ),
    );
    const body = calls[0]?.body as { contents: Array<{ parts: Array<{ inlineData?: { mimeType: string; data: string } }> }> };
    assert.deepEqual(body.contents[0]?.parts[1]?.inlineData, { mimeType: 'image/png', data: 'QUJD' });
  });

  test('a response_format it cannot translate is refused, not ignored', async () => {
    // Ignoring json_schema returns prose to a caller who asked for a shape,
    // and the failure surfaces later as a parse error with nothing pointing
    // back here. Throwing lets the mesh fall over to a provider that has it.
    const { fetch } = fakeFetch(() => geminiOk('hi'));
    await assert.rejects(
      () =>
        new GeminiAdapter().chat(
          ctx([{ role: 'user', content: 'hi' }], fetch, {
            response_format: { type: 'json_schema', json_schema: { name: 'x', schema: {} } },
          }),
        ),
      /response_format 'json_schema' is not translated/,
    );
  });

  test("json_object still becomes Gemini's own JSON mode", async () => {
    const { fetch, calls } = fakeFetch(() => geminiOk('hi'));
    await new GeminiAdapter().chat(
      ctx([{ role: 'user', content: 'hi' }], fetch, { response_format: { type: 'json_object' } }),
    );
    const body = calls[0]?.body as { generationConfig: { responseMimeType?: string } };
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
  });

  test('a remote image URL is refused loudly rather than dropped silently', async () => {
    const { fetch } = fakeFetch(() => geminiOk('hi'));
    await assert.rejects(
      () =>
        new GeminiAdapter().chat(
          ctx(
            [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }],
            fetch,
          ),
        ),
      /remote image URLs are not fetched/,
    );
  });
});

describe('gemini adapter — response shape', () => {
  test('translates into the OpenAI chat shape, usage included', async () => {
    const { fetch } = fakeFetch(() => geminiOk('hello there'));
    const res = await new GeminiAdapter().chat(ctx([{ role: 'user', content: 'x' }], fetch));
    assert.equal(res.object, 'chat.completion');
    assert.equal(res.choices[0]?.message.content, 'hello there');
    assert.equal(res.choices[0]?.finish_reason, 'stop');
    assert.deepEqual(res.usage, { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 });
  });

  test('finish reasons are mapped, and an unknown one is not invented', async () => {
    const cases: Array<[string, string]> = [
      ['STOP', 'stop'],
      ['MAX_TOKENS', 'length'],
      ['SAFETY', 'content_filter'],
      ['SOMETHING_NEW', 'something_new'],
    ];
    for (const [raw, expected] of cases) {
      const { fetch } = fakeFetch(
        () =>
          new Response(
            JSON.stringify({ candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: raw }] }),
            { status: 200 },
          ),
      );
      const res = await new GeminiAdapter().chat(ctx([{ role: 'user', content: 'x' }], fetch));
      assert.equal(res.choices[0]?.finish_reason, expected);
    }
  });

  test('an error response becomes a ProviderError carrying the status', async () => {
    const { fetch } = fakeFetch(
      () => new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 429 }),
    );
    await assert.rejects(
      () => new GeminiAdapter().chat(ctx([{ role: 'user', content: 'x' }], fetch)),
      (err: unknown) => {
        assert.ok(err instanceof ProviderError);
        assert.equal(err.status, 429);
        assert.match(err.message, /quota exceeded/);
        assert.equal(err.failoverable, true);
        return true;
      },
    );
  });

  test('its SSE is rewritten into OpenAI chunks, split across TCP boundaries', async () => {
    // The event is deliberately cut mid-JSON to prove the buffer reassembles it.
    const chunks = [
      'data: {"candidates":[{"content":{"pa',
      'rts":[{"text":"he"}]}}]}\n\n',
      'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}]}\n\n',
    ];
    const { fetch } = fakeFetch(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              const enc = new TextEncoder();
              for (const s of chunks) c.enqueue(enc.encode(s));
              c.close();
            },
          }),
          { status: 200 },
        ),
    );
    const stream = await new GeminiAdapter().stream(ctx([{ role: 'user', content: 'x' }], fetch));
    const out = await readAll(stream);
    const events = out
      .split('\n\n')
      .filter((l) => l.startsWith('data:') && !l.includes('[DONE]'))
      .map((l) => JSON.parse(l.slice(5)) as { object: string; choices: Array<{ delta: { role?: string; content?: string }; finish_reason: string | null }> });

    assert.equal(events.length, 2);
    assert.equal(events[0]?.object, 'chat.completion.chunk');
    assert.equal(events[0]?.choices[0]?.delta.role, 'assistant', 'role appears once, on the first chunk');
    assert.equal(events[0]?.choices[0]?.delta.content, 'he');
    assert.equal(events[1]?.choices[0]?.delta.role, undefined);
    assert.equal(events[1]?.choices[0]?.delta.content, 'llo');
    assert.equal(events[1]?.choices[0]?.finish_reason, 'stop');
    assert.match(out, /data: \[DONE\]/);
  });
});

describe('retry-after parsing', () => {
  test('seconds, HTTP dates and duration strings all resolve', () => {
    assert.equal(parseRetryAfter(new Response('', { headers: { 'retry-after': '30' } })), 30_000);
    assert.equal(parseDuration('1.5s'), 1500);
    assert.equal(parseDuration('250ms'), 250);
    assert.equal(parseDuration('2m30s'), 150_000);
  });

  test('a header that means nothing yields undefined, not 0', () => {
    // 0 would read as "retry immediately", which is the opposite of unknown.
    assert.equal(parseRetryAfter(new Response('')), undefined);
    assert.equal(parseDuration('later'), undefined);
  });
});
