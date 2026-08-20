import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { writeFetchResponse } from '../src/server/node.js';

/**
 * The bug this file exists for.
 *
 * `readable.pipe(res)` unpipes when the destination closes but does not destroy
 * the source, so a client hanging up mid-stream left the web stream
 * un-cancelled. Measured against a real provider: one abandoned SSE response
 * held a `maxConcurrent: 1` provider's slot indefinitely, while the mesh unit
 * tests all passed — they cancel the stream themselves, and the server never
 * did. Nothing below touches the mesh; the leak was in the Node bridge.
 */
describe('server — a client that hangs up', () => {
  /** A stream that never ends on its own, so only a cancel can stop it. */
  function endlessStream() {
    let cancelled: unknown = null;
    let cancels = 0;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"delta":"first"}\n\n'));
      },
      pull(c) {
        c.enqueue(new TextEncoder().encode('data: {"delta":"more"}\n\n'));
      },
      cancel(reason) {
        cancels += 1;
        cancelled = reason ?? new Error('cancelled');
      },
    });
    return {
      stream,
      wasCancelled: () => cancelled !== null,
      cancelCount: () => cancels,
    };
  }

  async function serving(body: ReadableStream<Uint8Array>): Promise<{
    url: string;
    close: () => Promise<void>;
    server: Server;
  }> {
    const server = createServer((_req, res) => {
      void writeFetchResponse(
        res,
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}/`,
      server,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  // An explicit timeout, because the regression this pins does not fail — it
  // hangs. The source stream never ends on its own, so a build that stopped
  // cancelling it would sit there forever instead of going red.
  test('cancels the source stream instead of leaving it running', { timeout: 10_000 }, async () => {
    const source = endlessStream();
    const { url, close } = await serving(source.stream);
    try {
      const ctrl = new AbortController();
      const res = await fetch(url, { signal: ctrl.signal });
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      await reader.read();
      assert.equal(source.wasCancelled(), false, 'still connected, nothing to cancel yet');

      ctrl.abort(new Error('client hung up'));
      // The destroy lands on the socket-close turn, not synchronously.
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(source.wasCancelled(), true, 'the provider stream must be cancelled');
    } finally {
      // In a `finally` so a failing assertion still lets the run exit: an
      // un-cancelled endless stream keeps the process alive by itself, which
      // would turn a red test into a hung CI job.
      await source.stream.cancel().catch(() => {});
      await close();
    }
  });

  test('a fully read stream is not cancelled behind the caller', async () => {
    // The guard is `readableEnded`; getting it wrong would cancel every
    // successful stream at the moment it finished, which no test would notice
    // because the bytes have already been delivered.
    let cancels = 0;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        c.close();
      },
      cancel() {
        cancels += 1;
      },
    });
    const { url, close } = await serving(body);
    const text = await (await fetch(url)).text();
    assert.match(text, /\[DONE\]/);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(cancels, 0);
    await close();
  });
});
