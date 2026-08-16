/**
 * Adapter for anything speaking the OpenAI chat API: Groq, DeepSeek,
 * OpenRouter, Cerebras, Together, xAI, a local llama.cpp/vLLM, and Cloudflare
 * Workers AI (which differs only in that the account id sits in the path).
 */

import {
  stripMeshFields,
  toProviderError,
  type Adapter,
  type AdapterContext,
} from './base.js';
import type { ChatResponse } from '../types.js';

function endpoint(ctx: AdapterContext): string {
  const base = ctx.candidate.provider.baseUrl.replace(/\/$/, '');
  if (ctx.candidate.provider.kind === 'workers-ai') {
    if (!ctx.accountId) {
      throw new Error(`workers-ai provider '${ctx.candidate.provider.id}' has no account id`);
    }
    return `${base}/accounts/${ctx.accountId}/ai/v1/chat/completions`;
  }
  return `${base}/chat/completions`;
}

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${ctx.apiKey}`,
    ...(ctx.candidate.provider.headers ?? {}),
  };
}

function body(ctx: AdapterContext, stream: boolean): string {
  const req = stripMeshFields(ctx.request);
  return JSON.stringify({
    ...req,
    // The caller addressed a mesh profile; the provider needs its own id.
    model: ctx.candidate.model.id,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
  });
}

export class OpenAICompatAdapter implements Adapter {
  readonly kind = 'openai-compat';

  async chat(ctx: AdapterContext): Promise<ChatResponse> {
    const res = await ctx.fetchImpl(endpoint(ctx), {
      method: 'POST',
      headers: headers(ctx),
      body: body(ctx, false),
      signal: ctx.signal,
    });
    if (!res.ok) throw await toProviderError(res);
    return (await res.json()) as ChatResponse;
  }

  async stream(ctx: AdapterContext): Promise<ReadableStream<Uint8Array>> {
    const res = await ctx.fetchImpl(endpoint(ctx), {
      method: 'POST',
      headers: { ...headers(ctx), accept: 'text/event-stream' },
      body: body(ctx, true),
      signal: ctx.signal,
    });
    if (!res.ok) throw await toProviderError(res);
    if (!res.body) throw await toProviderError(res);
    // Already OpenAI-shaped SSE: hand it straight through.
    return res.body;
  }
}
