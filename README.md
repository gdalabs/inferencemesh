# InferenceMesh

An OpenAI-compatible router that picks an LLM provider **per request** — by cost, capability,
language, privacy, remaining free quota, and observed health — and fails over when one is down.

Your application asks for `mesh/free` or `mesh/best`. It never learns whether Groq, Gemini,
Cloudflare Workers AI or OpenRouter actually answered.

```
POST /v1/chat/completions   { "model": "mesh/free", "messages": [...] }
                                        │
                            route → attempt → fall back → book
                                        │
              Groq · Gemini · Workers AI · OpenRouter · anything OpenAI-shaped
```

- **Zero dependencies, zero build-time provider SDKs.** Only `fetch`. The same bundle runs on
  Node 20+, Cloudflare Workers, Deno and Bun.
- **BYOK.** Keys come from your environment. A provider whose key is absent is dropped at load
  time and named in `warnings` — never silently.
- **Free tiers are first-class.** A quota ledger tracks requests-per-minute, requests-per-day and
  tokens-per-day per model, so the router skips an exhausted provider instead of earning a 429.
- **Privacy is a filter, not a preference.** A `confidential` request cannot be routed to a
  provider whose tier is `internal`, no matter how well it scores.
- **MIT.** The router is open. What you route *to* — and what you do with the answers — is yours.

---

## Install

```sh
npm install inferencemesh
```

Node 20 or newer. There is no runtime dependency to audit.

## Use as a library

```ts
import { InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.default.json' with { type: 'json' };

const mesh = new InferenceMesh({ registry: registryFrom(registryFile) });

const res = await mesh.chat({
  model: 'mesh/free',
  messages: [{ role: 'user', content: '日本語で答えて' }],
  mesh: { language: 'ja', privacy: 'public' },
});

console.log(res.choices[0].message.content);
console.log(res.mesh);
// { served_by: 'gemini/gemini-2.5-flash', profile: 'free',
//   attempts: [{ key: 'groq/llama-3.3-70b-versatile', status: 429, ... }],
//   latency_ms: 812, cost_usd: 0 }
```

`res.mesh.attempts` lists everything that was tried and failed on the way. Nothing is hidden:
if a provider 429'd and the request quietly moved elsewhere, it says so.

## Use as a gateway

```sh
export GROQ_API_KEY=...            # at least one provider
export INFERENCEMESH_TOKENS=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
npx inferencemesh serve
```

Then point any OpenAI client at it:

```sh
curl localhost:8910/v1/chat/completions \
  -H "authorization: Bearer $INFERENCEMESH_TOKENS" \
  -H 'content-type: application/json' \
  -d '{"model":"mesh/free","messages":[{"role":"user","content":"hello"}]}'
```

| Route | Purpose |
|---|---|
| `POST /v1/chat/completions` | OpenAI-compatible, streaming and non-streaming |
| `GET /v1/models` | mesh profiles plus every concrete `provider/model` |
| `GET /healthz` | breaker state, quota counters, load-time warnings |

The server **refuses to start without an auth token** and **refuses to bind `0.0.0.0`** unless you
override it. This process holds every provider key you own; an open LLM relay on a shared network
is somebody else's free inference budget. Put `tailscale serve` or a reverse proxy in front of it.

### On Cloudflare Workers

`handleRequest` is a plain Fetch handler, so a Worker is the whole integration:

```ts
import { handleRequest, InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from '../providers.json';

export default {
  async fetch(req: Request, env: Env) {
    const mesh = new InferenceMesh({ registry: registryFrom(registryFile, { env }) });
    return handleRequest(req, { mesh, tokens: new Set(env.GATEWAY_TOKENS.split(',')) });
  },
};
```

Use a KV- or Durable-Object-backed `LedgerStorage` if you want quota to survive isolate churn;
the in-memory default resets with the isolate, which under-counts against daily free-tier caps.

---

## Addressing a model

| `model` | Meaning |
|---|---|
| `mesh/free` | route within this profile |
| `mesh/best`, `mesh/cheap`, `mesh/fast`, `mesh/coding`, `mesh/vision`, `mesh/private` | built-in profiles |
| `groq/llama-3.3-70b-versatile` | pin one candidate |

A pin overrides the profile's **price** preference but **not** its privacy, capability or context
filters — a pin may not be used to smuggle confidential text into a public-tier provider.

Per-request overrides go in a `mesh` object, which is stripped before anything reaches a provider:

```json
{
  "model": "mesh/best",
  "messages": [],
  "mesh": {
    "language": "ja",
    "privacy": "confidential",
    "capabilities": ["vision"],
    "minContext": 100000
  }
}
```

## How a candidate is chosen

**Hard filters** (correctness — a rejected candidate is out, whatever it scores):
privacy tier · required capabilities · context window · profile price ceiling.

**Weighted score** (preference — every profile weights these differently):
`quality` · `cost` · observed `latency` · `language` competence.

**Then, in order:** breaker-open candidates are dropped (unless that would empty the pool — a
probably-down provider still beats no provider), quota is checked at attempt time, and the ranked
remainder becomes the fallback chain.

`inferencemesh route best --language=ja` prints the whole decision, including why each rejected
candidate was rejected, without touching the network.

### What is *not* retried

A `400` or `422` is the request's fault and will fail identically at every provider, so the chain
stops immediately. A `401` **is** retried, because the next provider does not share the bad key.

## Keeping the registry honest

`providers.default.json` ships **free tiers only, priced at 0** — the one number about a provider
that cannot go stale in a way that lies to you. Paid models are deliberately not shipped: their
prices change without notice, and a stale price does not fail loudly, it silently reorders the
`cheap` profile. Copy `providers.example.json` and fill in prices you have verified yourself.

Model ids and free tiers **do** rot, silently, and the first symptom is a user waiting on a reply.
Turn that into an exit code:

```sh
inferencemesh probe            # calls every candidate once; non-zero if any fail
inferencemesh probe --json     # for a scheduler
```

`quality` and `languages` scores are hand-maintained relative estimates, not benchmark results.
They only have to order *your* registry correctly.

## Development

```sh
npm test        # builds, then runs the suite (82 tests, no network)
npm run build
```

Every failure path in the suite is exercised with a deliberately broken input — a malformed
registry, an empty token set, a mid-JSON stream chunk, an expired quota window — because a check
that has never once fired is not known to work.

## License

MIT © GDA Labs
