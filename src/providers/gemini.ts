/**
 * Adapter for Google's native Generative Language API.
 *
 * Google also publishes an OpenAI-compatible shim, which would let Gemini be
 * configured as `openai-compat` and delete this file. It is implemented
 * natively anyway for two reasons: the shim is beta and has quietly dropped
 * fields (usage metadata in particular), and having one genuinely non-OpenAI
 * adapter keeps the boundary honest — if the abstraction only ever wraps
 * OpenAI clones, it is not an abstraction.
 */

import {
  SSE_DONE,
  sseLine,
  toProviderError,
  type Adapter,
  type AdapterContext,
} from './base.js';
import type { ChatContentPart, ChatMessage, ChatResponse, Usage } from '../types.js';

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

/** `data:image/png;base64,AAA...` -> inlineData. Remote URLs are not fetched. */
function inlineDataFromUrl(url: string): GeminiPart | null {
  const m = url.match(/^data:([^;,]+);base64,(.+)$/);
  if (!m) return null;
  return { inlineData: { mimeType: m[1] as string, data: m[2] as string } };
}

function partsOf(content: ChatMessage['content']): GeminiPart[] {
  if (content === null || content === undefined) return [];
  if (typeof content === 'string') return content ? [{ text: content }] : [];
  const out: GeminiPart[] = [];
  for (const part of content as ChatContentPart[]) {
    if (part.type === 'text') {
      out.push({ text: part.text });
    } else if (part.type === 'image_url') {
      const inline = inlineDataFromUrl(part.image_url.url);
      if (inline) {
        out.push(inline);
      } else {
        // A remote image would need fetching and re-encoding, which would make
        // the adapter an HTTP client for arbitrary user-supplied URLs. Refuse
        // loudly instead of silently dropping the image from the prompt.
        throw new Error(
          'gemini adapter: image_url must be a data: URL; remote image URLs are not fetched',
        );
      }
    }
  }
  return out;
}

interface GeminiBody {
  contents: Array<{ role: 'user' | 'model'; parts: GeminiPart[] }>;
  systemInstruction?: { parts: GeminiPart[] };
  generationConfig: Record<string, unknown>;
}

function toGeminiBody(ctx: AdapterContext): GeminiBody {
  const req = ctx.request;
  const contents: GeminiBody['contents'] = [];
  const systemParts: GeminiPart[] = [];

  for (const m of req.messages) {
    if (m.role === 'system') {
      systemParts.push(...partsOf(m.content));
      continue;
    }
    // 'tool' has no native equivalent in this subset; fold it in as user text
    // so the conversation is not silently truncated.
    const role: 'user' | 'model' = m.role === 'assistant' ? 'model' : 'user';
    const parts = partsOf(m.content);
    if (parts.length === 0) continue;
    const last = contents[contents.length - 1];
    // Gemini rejects consecutive same-role turns; merge them.
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }

  const generationConfig: Record<string, unknown> = {};
  if (req.temperature !== undefined) generationConfig['temperature'] = req.temperature;
  if (req.max_tokens !== undefined) generationConfig['maxOutputTokens'] = req.max_tokens;
  if (req.top_p !== undefined) generationConfig['topP'] = req.top_p;
  if (req.stop !== undefined) {
    generationConfig['stopSequences'] = Array.isArray(req.stop) ? req.stop : [req.stop];
  }
  if (req.response_format?.type === 'json_object') {
    generationConfig['responseMimeType'] = 'application/json';
  }

  const body: GeminiBody = { contents, generationConfig };
  if (systemParts.length > 0) body.systemInstruction = { parts: systemParts };
  return body;
}

function textOf(c: GeminiCandidate | undefined): string {
  return (c?.content?.parts ?? []).map((p) => p.text ?? '').join('');
}

/** Gemini finish reasons -> OpenAI finish reasons. */
function finishReason(raw: string | undefined): string {
  switch (raw) {
    case 'STOP':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'PROHIBITED_CONTENT':
      return 'content_filter';
    default:
      return raw ? raw.toLowerCase() : 'stop';
  }
}

function usageOf(r: GeminiResponse): Usage | undefined {
  const u = r.usageMetadata;
  if (!u) return undefined;
  const prompt = u.promptTokenCount ?? 0;
  const completion = u.candidatesTokenCount ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: u.totalTokenCount ?? prompt + completion,
  };
}

function url(ctx: AdapterContext, method: string, sse: boolean): string {
  const base = ctx.candidate.provider.baseUrl.replace(/\/$/, '');
  return `${base}/models/${ctx.candidate.model.id}:${method}${sse ? '?alt=sse' : ''}`;
}

function headers(ctx: AdapterContext): Record<string, string> {
  return {
    'content-type': 'application/json',
    // Header rather than ?key= so the key never lands in a proxy access log.
    'x-goog-api-key': ctx.apiKey,
    ...(ctx.candidate.provider.headers ?? {}),
  };
}

export class GeminiAdapter implements Adapter {
  readonly kind = 'gemini';

  async chat(ctx: AdapterContext): Promise<ChatResponse> {
    const res = await ctx.fetchImpl(url(ctx, 'generateContent', false), {
      method: 'POST',
      headers: headers(ctx),
      body: JSON.stringify(toGeminiBody(ctx)),
      signal: ctx.signal,
    });
    if (!res.ok) throw await toProviderError(res);
    const data = (await res.json()) as GeminiResponse;
    const first = data.candidates?.[0];
    return {
      id: `mesh-${ctx.candidate.provider.id}-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: ctx.candidate.model.id,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: textOf(first) },
          finish_reason: finishReason(first?.finishReason),
        },
      ],
      ...(usageOf(data) ? { usage: usageOf(data) as Usage } : {}),
    };
  }

  async stream(ctx: AdapterContext): Promise<ReadableStream<Uint8Array>> {
    const res = await ctx.fetchImpl(url(ctx, 'streamGenerateContent', true), {
      method: 'POST',
      headers: { ...headers(ctx), accept: 'text/event-stream' },
      body: JSON.stringify(toGeminiBody(ctx)),
      signal: ctx.signal,
    });
    if (!res.ok || !res.body) throw await toProviderError(res);

    const id = `mesh-${ctx.candidate.provider.id}-${Date.now()}`;
    const model = ctx.candidate.model.id;
    const created = Math.floor(Date.now() / 1000);
    const decoder = new TextDecoder();
    let buffer = '';
    let sentRole = false;

    return res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          // SSE events are separated by a blank line; a chunk may split one.
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const event = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const line = event.split('\n').find((l) => l.startsWith('data:'));
            if (!line) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            let parsed: GeminiResponse;
            try {
              parsed = JSON.parse(payload) as GeminiResponse;
            } catch {
              continue;
            }
            const cand = parsed.candidates?.[0];
            const text = textOf(cand);
            const delta: Record<string, unknown> = {};
            if (!sentRole) {
              delta['role'] = 'assistant';
              sentRole = true;
            }
            if (text) delta['content'] = text;
            const usage = usageOf(parsed);
            controller.enqueue(
              sseLine({
                id,
                object: 'chat.completion.chunk',
                created,
                model,
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: cand?.finishReason ? finishReason(cand.finishReason) : null,
                  },
                ],
                ...(usage ? { usage } : {}),
              }),
            );
          }
        },
        flush(controller) {
          controller.enqueue(SSE_DONE);
        },
      }),
    );
  }
}
