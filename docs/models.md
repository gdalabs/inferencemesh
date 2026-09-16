# What the shipped registry can reach

**Generated from `providers.default.json` — do not edit by hand.** Run
`node scripts/generate-models-doc.mjs`; a test fails when this file and the
registry disagree, so a model that leaves a free tier cannot quietly leave
this page saying it is still there.

11 providers, 37 models, 30 of them enabled.
Every model here is free to call. A non-zero price without a verification
date fails validation, and paid entries belong in your own copy of
`providers.example.json`, never in this one.

A model is **disabled** when nothing has probed it, or when a probe found
it gone. Disabled entries are kept rather than deleted, because a
disappearance is the event worth seeing on the next diff.

## nous

**Key:** `NOUS_API_KEY` · **Privacy tier:** `public` · **Enabled:** 0/5

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✗ | `poolside/laguna-s-2.1:free` | 262,144 | text, tools | — | — | free |
| ✗ | `poolside/laguna-xs-2.1:free` | 262,144 | text, tools | — | — | free |
| ✗ | `stepfun/step-3.7-flash:free` | 262,144 | text, vision, video, tools, json | — | — | free |
| ✗ | `upstage/solar-pro4:free` | 524,288 | text, tools, json | — | — | free |
| ✗ | `meituan/longcat-2.0:free` | 1,048,576 | text, tools | — | — | free |

Sign up: https://portal.nousresearch.com/

## groq

**Key:** `GROQ_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 4/4

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `llama-3.3-70b-versatile` | 131,072 | text, code, tools, json | 30/min · 1000/day | 0.72 | free |
| ✓ | `llama-3.1-8b-instant` | 131,072 | text, code, tools, json | 30/min · 14400/day | 0.50 | free |
| ✓ | `minimaxai/minimax-m2.7` | 131,072 | text, code, tools, json | 30/min · 1000/day | 0.78 | free |
| ✓ | `qwen/qwen3.6-27b` | 131,072 | text, code, tools, json | 30/min · 1000/day | 0.70 | free |

Sign up: https://console.groq.com/keys

## gemini

**Key:** `GEMINI_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 2/2

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `gemini-2.5-flash` | 1,048,576 | text, code, vision, ocr, tools, json | 10/min · 250/day | 0.82 | free |
| ✓ | `gemini-2.0-flash` | 1,048,576 | text, code, vision, ocr, tools, json | 15/min · 200/day | 0.74 | free |

Sign up: https://aistudio.google.com/apikey

## nvidia

**Key:** `NVIDIA_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 5/5

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `deepseek-ai/deepseek-v4-flash-0731` | 131,072 | text, code, tools, json | 30/min | 0.86 | free |
| ✓ | `moonshotai/kimi-k2.6` | 131,072 | text, code, vision, tools, json | 30/min | 0.85 | free |
| ✓ | `minimaxai/minimax-m3` | 131,072 | text, code, tools, json | 30/min | 0.80 | free |
| ✓ | `z-ai/glm-5.2` | 131,072 | text, code, tools, json | 30/min | 0.84 | free |
| ✓ | `deepseek-ai/deepseek-coder-6.7b-instruct` | 16,384 | text, code | 30/min | 0.45 | free |

Sign up: https://build.nvidia.com/

## zai

**Key:** `ZAI_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 3/3

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `glm-4.7-flash` | 131,072 | text, code, tools, json | 60/min · 1000/day | 0.72 | free |
| ✓ | `glm-4.5-flash` | 131,072 | text, code, tools, json | 60/min · 1000/day | 0.64 | free |
| ✓ | `glm-4.6v-flash` | 65,536 | text, vision, ocr, json | 60/min · 1000/day | 0.62 | free |

Sign up: https://z.ai/manage-apikey/apikey-list

## modelscope

**Key:** `MODELSCOPE_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 3/3

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `deepseek-ai/DeepSeek-V4-Flash-0731` | 131,072 | text, code, json | — | 0.86 | free |
| ✓ | `MiniMax/MiniMax-M3` | 131,072 | text, code, json | — | 0.80 | free |
| ✓ | `Qwen/Qwen3-235B-A22B-Instruct-2507` | 131,072 | text, code, json | — | 0.78 | free |

Sign up: https://modelscope.cn/my/myaccesstoken

## cloudflare

**Key:** `CLOUDFLARE_API_TOKEN` · **Privacy tier:** `internal` · **Enabled:** 5/5

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `@cf/moonshotai/kimi-k2.5` | 256,000 | text, code, vision, tools, json | — | 0.80 | free |
| ✓ | `@cf/zai-org/glm-4.7-flash` | 131,072 | text, code, tools, json | — | 0.72 | free |
| ✓ | `@cf/deepseek-ai/deepseek-r1-distill-qwen-32b` | 80,000 | text, code, json | — | 0.62 | free |
| ✓ | `@cf/qwen/qwen3-30b-a3b-fp8` | 32,768 | text, code, json | — | 0.60 | free |
| ✓ | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | 24,000 | text, code, json | — | 0.68 | free |

Sign up: https://dash.cloudflare.com/profile/api-tokens

## openrouter-free

**Key:** `OPENROUTER_API_KEY` · **Privacy tier:** `internal` · **Enabled:** 3/4

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `nvidia/nemotron-3-ultra-550b-a55b:free` | 1,000,000 | text, code, json | 20/min · 50/day | 0.84 | free |
| ✓ | `nvidia/nemotron-3-super-120b-a12b:free` | 262,144 | text, code, json | 20/min · 50/day | 0.76 | free |
| ✓ | `google/gemma-4-31b-it:free` | 262,144 | text, code, vision, json | 20/min · 50/day | 0.70 | free |
| ✗ | `openai/gpt-oss-20b:free` | 131,072 | text, code, json | 20/min · 50/day | 0.60 | free |

Sign up: https://openrouter.ai/keys

## ovhcloud

**Key:** `OVH_AI_TOKEN` · **Privacy tier:** `internal` · **Enabled:** 2/2

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `Qwen3.5-397B-A17B` | 131,072 | text, code, json | — | 0.82 | free |
| ✓ | `Qwen3.6-27B` | 131,072 | text, code, json | — | 0.70 | free |

Sign up: https://endpoints.ai.cloud.ovh.net/

## llm7

**Key:** `LLM7_API_KEY` · **Privacy tier:** `public` · **Enabled:** 1/1 · **Max concurrent:** 1

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `minimax-m2.7` | 204,800 | text, code, tools, json | 30/min | 0.76 | free |

Sign up: https://token.llm7.io/

## orcarouter

**Key:** `ORCAROUTER_API_KEY` · **Privacy tier:** `public` · **Enabled:** 2/3 · **Account-wide quota:** 10/min · 50/day

> The quota above belongs to the **key**, not to each model: all of this
> provider's models draw on the same budget.

| | Model | Context | Capabilities | Quota | Quality | Price |
|---|---|---:|---|---|---:|---|
| ✓ | `deepseek/deepseek-v4-flash-free` | 30,000 | text, code, tools, json | — | — | free |
| ✗ | `qwen/qwen3.8-27b-free` | 55,000 | text, code, tools, json | — | — | free |
| ✓ | `tencent/hy3-free` | 30,000 | text, tools, json | — | — | free |

Sign up: https://www.orcarouter.ai/console/keys

## Reading the context column

For most providers it is the model's context window. For `orcarouter` it is
not: the free tier refuses a request by **size** well below the catalogued
window, and a 400 stops the fallback chain rather than moving on, so the
number recorded is a measured floor rather than the advertised maximum. It
was measured with ASCII; Japanese hits the limit sooner.
