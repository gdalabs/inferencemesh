import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';

import { Registry } from '../src/registry.js';
import { InferenceMesh } from '../src/mesh.js';
import { QuotaLedger, MemoryStorage } from '../src/ledger.js';
import { HealthTracker } from '../src/health.js';
import { MeshError, type ChatMessage } from '../src/types.js';
import {
  FIXTURE_ENV,
  errorResponse,
  fakeClock,
  fakeFetch,
  fixtureProviders,
  okChat,
} from './helpers.js';

function mesh(responder: Parameters<typeof fakeFetch>[0]) {
  const clock = fakeClock();
  const { fetch, calls } = fakeFetch(responder);
  const registry = new Registry(fixtureProviders(), { env: FIXTURE_ENV });
  const m = new InferenceMesh({
    registry,
    fetchImpl: fetch,
    ledger: new QuotaLedger(new MemoryStorage(), clock.now),
    health: new HealthTracker({}, clock.now),
  });
  return { m, calls };
}

const masked = (model = 'mesh/free') => ({
  model,
  messages: [
    { role: 'system', content: 'あなたは田中商事の顧問である' },
    { role: 'user', content: '田中商事は佐藤と合併しますか？' },
  ] as ChatMessage[],
  mesh: { mask: ['田中商事', '佐藤'] },
});

describe('mesh — masked requests', () => {
  test('the wire carries aliases, the caller gets the originals back', async () => {
    const { m, calls } = mesh(() => okChat('はい、[[IMESH-E1]]は[[IMESH-E2]]と合併します。'));
    const res = await m.chat(masked());
    const sent = calls[0]?.body as { messages: Array<{ content: string }> };
    assert.equal(sent.messages[0]?.content, 'あなたは[[IMESH-E1]]の顧問である');
    assert.equal(sent.messages[1]?.content, '[[IMESH-E1]]は[[IMESH-E2]]と合併しますか？');
    for (const msg of sent.messages) {
      assert.ok(!msg.content.includes('田中商事') && !msg.content.includes('佐藤'));
    }
    assert.equal(
      res.choices[0]?.message.content,
      'はい、田中商事は佐藤と合併します。',
    );
  });

  test('the mask list itself is stripped before the provider sees the body', async () => {
    const { m, calls } = mesh(() => okChat('ok'));
    await m.chat(masked());
    const sent = calls[0]?.body as Record<string, unknown>;
    assert.equal(sent['mesh'], undefined);
  });

  test('fallback retries reuse the redacted prompt, never the original', async () => {
    const { m, calls } = mesh((call) =>
      call.url.includes('alpha') ? errorResponse(429, 'rate limited') : okChat('[[IMESH-E1]]です'),
    );
    const res = await m.chat(masked());
    assert.equal(calls.length, 2);
    for (const call of calls) {
      const msgs = (call.body as { messages: Array<{ content: string }> }).messages;
      assert.ok(msgs.every((msg) => !msg.content.includes('田中商事')));
    }
    assert.equal(res.choices[0]?.message.content, '田中商事です');
  });

  test('no mask means the request passes through untouched', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    await m.chat({ model: 'mesh/free', messages: [{ role: 'user', content: '田中商事' }] });
    assert.equal(
      (calls[0]?.body as { messages: Array<{ content: string }> }).messages[0]?.content,
      '田中商事',
    );
  });

  test('mask with stream is refused loudly, not sent half-masked', async () => {
    const { m, calls } = mesh(() => okChat('hi'));
    await assert.rejects(
      m.stream({ ...masked(), stream: true }),
      (err: unknown) => err instanceof MeshError && err.status === 400,
    );
    assert.equal(calls.length, 0);
  });

  test('a prompt that already holds an alias token is a 400, not a 500', async () => {
    const { m } = mesh(() => okChat('hi'));
    await assert.rejects(
      m.chat({
        model: 'mesh/free',
        messages: [{ role: 'user', content: '[[IMESH-E1]]は誰？' }],
        mesh: { mask: ['誰'] },
      }),
      (err: unknown) => err instanceof MeshError && err.status === 400,
    );
  });
});
