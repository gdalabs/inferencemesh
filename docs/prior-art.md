# Prior art: what else routes across free LLM tiers

Read on 2026-08-28. **Nothing here was benchmarked.** This is a reading of
published documentation and source, not a measurement — no keys were used and
no free quota was spent, so every row is "what the project says about itself"
unless marked otherwise. Where a claim matters, the wording is quoted.

That distinction is the same one the registry makes: a documented limit is not
an observed one. Treat this file the way `sync` treats a catalog — machine
facts that go stale, kept separate from judgement.

## The short version

Two questions were asked of each project:

1. **Does it model a free tier?** Not "does it have rate limits" — does it know
   that a key gets 50 requests *per day* and stop at 50, rather than discovering
   the limit by being refused?
2. **Does it decompose a request before routing?** Split one question into
   parts, so that no single upstream provider receives the whole thing.

Almost everything answers "yes" to some form of routing and "no" to both of
these. The projects that decompose do it for capability or cost, not to keep an
upstream from learning what the user is doing.

## The gateways

| Project | License / runtime | Free-tier accounting | Fallback | Decomposition |
|---|---|---|---|---|
| [free-llm-gateway](https://github.com/MrFadiAi/free-llm-gateway) | MIT, Python (FastAPI + SQLite) | **Yes** — "RPM/RPD/TPM/TPD monitoring with rolling time windows and provider free-tier limits" | Yes, plus penalty routing on 429 and per-key cooldown | No |
| [LiteLLM](https://docs.litellm.ai/docs/routing) | MIT, Python | Partial — per-deployment `tpm`/`rpm`, no daily quota | Yes, ordered deployments then fallback groups; cooldown after `allowed_fails` | No |
| [Portkey Gateway](https://github.com/Portkey-AI/gateway) | MIT, Node (also Workers) | Not documented — "rate limits" only | Yes, plus "conditional routing" | No |
| [Bifrost](https://github.com/maximhq/bifrost) | Apache-2.0, Go | Not documented — budgets and rate limiting, not daily free quotas | Yes, plus key-level load balancing | No |
| [Cloudflare AI Gateway](https://developers.cloudflare.com/ai-gateway/) | Managed service | No | Yes | No |
| [OpenRouter](https://openrouter.ai/docs/api-reference/limits) | Hosted | It *is* the limit: 20 req/min, and 50 req/day under 10 lifetime credits, 1,000 above | Yes, its own | No |
| [RouteLLM](https://github.com/lm-sys/RouteLLM) | Apache-2.0, Python | No — "not provider-fallback or quota-aware" | No | No |
| [optillm](https://github.com/codelion/optillm) | Apache-2.0, Python | No | Via a proxy plugin | **Yes, but same upstream** |
| [Plano](https://github.com/katanemo/plano) (was `archgw`) | Apache-2.0, Rust on Envoy | Not documented | Yes | **Yes, to different agents** |

### The closest thing to this project

`free-llm-gateway` is the one that overlaps, and it overlaps a lot: 24 free
providers, per-key RPM/RPD/TPM/TPD with rolling windows, token estimation
*before* routing so a request is not sent into a limit it will bounce off,
429-driven deprioritisation, and AES-256-GCM key storage at rest. Several of
those are the same conclusions this codebase reached independently.

It differs in three ways worth naming honestly rather than spinning:

- It **falls back to paid** — optional Anthropic, OpenAI and Perplexity keys sit
  behind the free ones. That is a deliberate non-goal here, for a reason that is
  about consequence rather than taste: a free tier that quietly becomes a bill
  is the failure a beginner cannot see coming.
- It is Python + FastAPI + SQLite, so it runs where those run. The zero-runtime-
  dependency constraint in this codebase exists to also run on Workers and Deno.
- It encrypts keys at rest; this codebase instead has no read path at all
  (`KeyStore` has no `get`). Different answers to the same worry, and its answer
  is the better one if you need the key back for another purpose.

**It is not true that free-tier accounting is unique here.** It was, at most,
uncommon.

## Routing on sensitivity is also not new

LiteLLM ships a [Sensitive Data Routing
guardrail](https://docs.litellm.ai/docs/proxy/guardrails/sensitive_data_routing)
that scans messages for configured patterns and rewrites the target to an
on-prem model on a match, and [tag
routing](https://docs.litellm.ai/docs/proxy/tag_routing) that restricts the
candidate set to deployments carrying a caller-supplied tag.

The difference from `maxPrivacy` here is narrower than it first looks, and it is
about who decides:

- LiteLLM's guardrail **infers** sensitivity by scanning the text. It can miss.
- `maxPrivacy` is **declared** by the caller and used as a hard filter, so a
  confidential request cannot reach a public-tier provider even if the text
  looks innocuous — and a pin cannot override it.

Inference catches what the caller forgot to label. Declaration catches what no
pattern matches. Neither subsumes the other, and the guardrail approach is the
one that helps a caller who does not know their own data is sensitive.

## Pre-processing: does splitting a query hide what you are doing?

This is the question worth the research, and the honest answer has a sharp edge.

### What exists in the gateway layer

**Nothing.** No general-purpose LLM gateway surveyed decomposes a request for
the purpose of concealing intent. The two that decompose do it for other
reasons:

- **optillm** transforms a request into many — mixture-of-agents, plan-search,
  self-consistency, MCTS, best-of-N — but every sub-call goes to **the same
  configured upstream**. From the provider's side this is *more* exposure, not
  less: it sees the question repeatedly, plus the intermediate reasoning.
- **Plano** (formerly `archgw`) uses a 4B routing model to decompose a query and
  send parts to **different agents**. The split is by capability, and the parts
  are still whole sub-questions.

### What exists in the research

[Privacy Guard & Token Parsimony by Prompt and Context Handling and LLM
Routing](https://arxiv.org/html/2603.28972) (Alessio Langiu, CNR-ISMAR;
arXiv:2603.28972v1, 2026-08-24) is the design in question, published four days
before this file. A **local** small model acts as "Context Retriever and Task
Decomposer", rewriting a request into isolated sub-problems, "minimising the
active working context for each sub-task, natively filtering out unnecessary
secrets", and routes the fragments across four trust tiers (untrusted →
commercial → jurisdiction-constrained → on-prem). The stated aim is that no
single cloud provider receives the complete context.

Reported: 45% blended cost reduction, 100% redaction of personal secrets, 1.20%
residual leakage of institutional secrets at 70B, no measured utility loss.
These are the author's numbers on the author's benchmark; nothing here
reproduces them.

[Privacy-R1](https://arxiv.org/html/2510.16054) (arXiv:2510.16054v2) is the
adjacent shape: an RL policy that segments a query into chunks and sends each
either to a local model or to a remote one. It explicitly does **not** spread a
query across several external providers — one local, one remote. It reports
88.4% quality retention at 12.0% leakage, against PAPILLON's 76.2% / 18.5%.

### The catch, stated plainly

**The decomposer must be local, or the whole idea inverts.** Splitting a
question into fragments requires something that understands the whole question.
If that something is one of the free providers, the design has done the opposite
of its purpose: it has handed the single most revealing artefact — the complete
intent, in one request — to exactly the tier it was trying to keep in the dark,
and then distributed harmless pieces to everyone else. Both papers use a local
SLM for this. That is not an implementation detail; it is the load-bearing part.

Three further limits, none of which the papers claim to solve:

- **Fragments do not decorrelate on their own.** Same key, same account, same
  IP, adjacent timestamps. A provider holding three of your fragments a second
  apart is not guessing. Distributing across providers only helps to the extent
  the providers do not share an operator — and OrcaRouter's `free` endpoint,
  already excluded from the shipped registry, is the demonstration that you
  cannot always tell who is behind an endpoint.
- **Free tiers are the tier most likely to retain.** OpenRouter's own privacy
  page notes "separate settings for paid and free models" for whether requests
  may route to providers that train on data. The exact default is not stated
  there and was not verified; it should be, before any claim rests on it.
- **Fragments reveal more than they look like they do.** No measurement here
  establishes that a set of sub-queries leaks less than the original. The one
  paper that measures it measures its own decomposer on its own data.

## What this means for this project

- Free-tier accounting is a **table stake**, not a differentiator. `free-llm-
  gateway` got there too. What can still be claimed is that the accounting is
  reserved at admission and refunded on failure, in two layers (account and
  model), which is a correctness property rather than a feature.
- Refusing to fall back to paid remains genuinely uncommon. Every gateway
  surveyed treats paid fallback as a feature.
- Decomposition-for-concealment is **unbuilt in this layer** and now has a
  published design. It is also the one feature that cannot be added honestly
  without a local model in the loop, which is a dependency this project does not
  currently have and should not pretend to.
- If it is ever built, it needs a measurement before a claim — the same rule as
  prices, capabilities and `maxConcurrent`. "Fragments leak less" is exactly the
  kind of plausible number that nothing later would catch.

## Sources

All read 2026-08-28.

- [free-llm-gateway](https://github.com/MrFadiAi/free-llm-gateway)
- [LiteLLM routing](https://docs.litellm.ai/docs/routing) · [sensitive data routing](https://docs.litellm.ai/docs/proxy/guardrails/sensitive_data_routing)
- [Portkey Gateway](https://github.com/Portkey-AI/gateway)
- [Bifrost](https://github.com/maximhq/bifrost)
- [RouteLLM](https://github.com/lm-sys/RouteLLM)
- [optillm](https://github.com/codelion/optillm)
- [Plano](https://github.com/katanemo/plano)
- [OpenRouter limits](https://openrouter.ai/docs/api-reference/limits) · [privacy and logging](https://openrouter.ai/docs/features/privacy-and-logging)
- Langiu, A. "Privacy Guard & Token Parsimony by Prompt and Context Handling and LLM Routing", [arXiv:2603.28972](https://arxiv.org/html/2603.28972), 2026-08-24
- "Privacy-R1: Privacy-Aware Multi-LLM Agent Collaboration via Reinforcement Learning", [arXiv:2510.16054](https://arxiv.org/html/2510.16054)
