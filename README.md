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

## Start with no key and no signup

```sh
INFERENCEMESH_TOKENS=$(openssl rand -hex 32) docker compose up
```

That is the whole setup. With **no provider keys at all** the mesh still routes,
because some providers run an open free tier — verified end to end: a container
started with an empty environment answers a real chat request.

Compose reads the key file sitting beside it, so keys `inferencemesh setup`
already wrote are picked up without being listed anywhere. Worth knowing in
both directions: it is why the container has your keys, and why that file must
never be committed.

```sh
curl localhost:8910/v1/chat/completions \
  -H "authorization: Bearer $INFERENCEMESH_TOKENS" \
  -H 'content-type: application/json' \
  -d '{"model":"mesh/free","messages":[{"role":"user","content":"hello"}]}'
```

Adding keys makes it better. Open the setup page — the URL with the token is
printed at startup:

```
[inferencemesh] add keys here: http://127.0.0.1:8910/setup#<token>
```

It lists every provider with what it gives you, **click-by-click steps to get the
key**, what the key looks like (`nvapi-…`), a paste box, and a live check. A
verified key takes effect immediately; nothing restarts.

**Your keys stay on your machine.** There is no hosted component. A key goes to
exactly two places: a `600` file in your own volume, and the provider it belongs
to. No endpoint can return a stored key — `/v1/providers` reports only whether one
is present — and none of it is logged. That is enforced by tests, not just stated.

`inferencemesh setup` does the same thing from a terminal:
it says what each provider gives you, prints the page to get the key, and
**verifies the key with a real request before saving it** — because "Saved!"
is not reassurance when a mistyped key saves just as happily as a working one.

### What a free tier actually costs

Free is a trade, and the terms are rarely spelled out. `setup` prints these
before it asks for anything:

- **Your prompts may train the provider's models.** Do not send private,
  medical, or other people's personal data.
- **Never ship the key to a browser or a phone app.** Keep it behind a server;
  this gateway is that server.
- **No uptime promise.** Free tiers get withdrawn without notice.
- **Some free models say their reasoning out loud** ("The user asks…"). That is
  the model, not a bug in your code.
- **This gateway never falls back to a paid model.** Exhausted free tiers return
  an error, so a mistake cannot turn into a bill.

## Install

```sh
npm install inferencemesh
```

Node 20 or newer. There is no runtime dependency to audit — the container image
contains the compiled output and nothing else.

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

`handleRequest` is a plain Fetch handler, so a Worker is the whole integration. This is
[`examples/worker.ts`](examples/worker.ts), which the build compiles — a snippet that lives only in
a README is one nobody has ever run:

```ts
import { handleRequest, InferenceMesh, registryFrom } from 'inferencemesh';
import registryFile from './providers.json';

/**
 * Bindings. The index signature is what lets the whole `env` be handed to the
 * registry as its source of provider keys — each provider names the variable
 * it wants, so they are not listed here one by one.
 */
interface Env {
  GATEWAY_TOKENS: string;
  [key: string]: string | undefined;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
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

### How many at once

Rate limits come in two shapes and only one of them is a window. `quota` counts requests per
minute and per day; `maxConcurrent` counts the ones happening *right now*. A provider that serves
one request at a time will 429 a fan-out while its per-minute budget is barely touched, so
counting the window alone cannot see it.

```jsonc
{ "id": "some-provider", "maxConcurrent": 2, "models": [ /* ... */ ] }
```

It is scoped to the provider, not the model: the limit belongs to the credential, so two models
behind one key share the account's slots.

A busy provider is skipped, not waited for — falling over to a free one is what the chain is for.
Only when **every** candidate is busy does the request queue, FIFO, for up to
`INFERENCEMESH_CONCURRENCY_WAIT_MS` (default 30000; set `0` to fail instead). That is the
single-provider case: a 503 now is worse than an answer a moment later.

Omit `maxConcurrent` and the provider is unlimited. A limit nobody has measured would throttle
real capacity on a guess, so the shipped registry sets one only where it was observed: `llm7`
allows **1**, found on 2026-08-22 by raising the parallelism until the second in-flight request
came back `429 Too many concurrent requests for this client`, reproduced three times. Find yours
the same way, or in the provider's docs — and write the date next to it.

## Configuration

Every setting is an environment variable; the server reads no config file of its own.

| Variable | Default | What it does |
| --- | --- | --- |
| `INFERENCEMESH_TOKENS` | *(none)* | Comma-separated bearer tokens. **The server refuses to start without one** — an unauthenticated LLM relay is somebody else's free inference. |
| `INFERENCEMESH_PORT` | `8910` | Port to listen on. |
| `INFERENCEMESH_HOST` | `127.0.0.1` | Interface to bind. Binding `0.0.0.0` additionally requires `INFERENCEMESH_ALLOW_ANY_HOST=1`, because this process holds every provider key you own. |
| `INFERENCEMESH_ALLOW_ANY_HOST` | unset | Permits a non-loopback bind. Set inside a container, where the network namespace is the boundary; think twice anywhere else. |
| `INFERENCEMESH_ALLOWED_ORIGINS` | *(none)* | Comma-separated browser origins allowed to call the API directly. Empty means no CORS headers at all. |
| `INFERENCEMESH_PUBLIC_HEALTH` | unset | `1` exposes `/healthz` without a token. It reports provider ids, breaker state and quota — useful for an uptime check, and not nothing to hand out. |
| `INFERENCEMESH_REGISTRY` | *(discovered)* | Path to a registry file. Naming one that does not exist is an error rather than a silent fall back to the built-in copy. |
| `INFERENCEMESH_KEYS` | `.inferencemesh/keys.env` | Where keys added through the setup page are stored, mode 600. |
| `INFERENCEMESH_LEDGER` | `.inferencemesh/ledger.json` | Quota counters. Put it on a volume, or every restart forgets what the day has already spent. |
| `INFERENCEMESH_CONCURRENCY_WAIT_MS` | `30000` | How long to queue when *every* candidate is busy. `0` fails instead of waiting. |
| `INFERENCEMESH_LANG` | *(locale)* | `ja` or `en` for the setup wizard. Defaults to the system locale. |

Provider keys are their own variables, named by each entry's `apiKeyEnv` — `GROQ_API_KEY`,
`OPENROUTER_API_KEY`, and so on. A provider whose key is absent is skipped and named in `/healthz`.

## Generating a registry

A hand-written registry is a snapshot of a market that moves weekly, and a
hand-written price is a claim about a day that has passed. `sync` reads a
provider's own catalog and writes the parts a machine can know:

```sh
inferencemesh sync --provider=redpill    --out=providers.local.json --dry-run
inferencemesh sync --provider=openrouter --out=providers.local.json --dry-run
```

OpenRouter's catalog is **keyless** — the model list is public, so this one can
be refreshed without spending anybody's credit. It is read free-tier only: 421
models on 2026-08-22, of which 22 were priced at zero, and the registry
provider it fills is the free tier by definition.

"Free" there means every published price is zero, not just per-token. The
pricing object also carries `web_search`, `image`, the cache keys and —
the one that would actually catch someone — `overrides`, a list of
time-of-day windows with prices of their own. A model quoting zero per token
and charging between 06:00 and 24:00 UTC is not free, it is free-looking.

Refreshed every run: existence, context window, capabilities, price — stamped
with `priceVerifiedAt` for the day the catalog was read, because the catalog
*is* the provider's pricing page.

Never written: `quality` and `languages`. A catalog does not know whether a
model is any good or whether it can hold a conversation in Japanese, and a
plausible guess there silently reorders the `best` profile and mis-serves every
non-English caller — the same failure as an unverified price, with no invoice
to catch it. New entries come out unrated and score neutrally until you rate
them.

A provider stanza that sync has to create comes out at `maxPrivacy: "public"`, the lowest tier,
and says so. Generating `internal` would be sync deciding what a provider may be trusted with —
the exact judgement it refuses to make on an entry that already exists, made silently on a new one.

Also never written: `maxPrivacy` on an entry that already exists. Comparing the
catalog against it cannot tell "a human raised this" from "the vendor
downgraded it", and those need opposite responses. What the catalog supports is
recorded separately in `evidencePrivacy`, so the two can be diffed against each
other. If your file allows more than the catalog supports, sync exits non-zero
until you either lower it or record a `privacyVerifiedAt` — and it goes loud
again the moment the catalog's own answer changes, which is exactly when an
old sign-off stops meaning anything.

A model that disappears from a catalog is disabled, not deleted: deleting would
throw away your rating and make the disappearance invisible on the next diff.

### The one warning that arrives early

Everything else about rot is discovered afterwards, by a user waiting on a 404.
`expiration_date` is the exception: a provider announcing, in machine-readable
form, that a free tier ends on a date. Sync records it as `expiresAt` and warns
when it is within 60 days — three of the nvidia `:free` ids were two days out
when this was written.

`probe` and `route` say it too, since a sync report is read when the registry
is being regenerated and not when you want to hear that something you route to
stops existing on Monday.

Nothing routes on it. A date is a statement of intent, not an observation, and
a model that outlives its own announced expiry should keep serving rather than
be dropped by arithmetic in a JSON file. Far-future sentinels (OpenRouter
writes `2098-12-31` for "no expiry") are recorded and not announced, because a
warning that fires every run buries the one that matters.

### What a catalog cannot tell you

Absent is not denied. RedPill lists 14 models with no declared parameters at
all, six of them TEE-hosted, and at least one of those answers tool calls
perfectly well. Sync records only `text` for those and warns; it never writes
"no tools" on a claim nobody made, and it never overwrites capabilities you
recorded after probing.

That last part is narrower than it sounds, and it is worth being precise about:
a catalog owns the capabilities it can actually express — `text`, `vision`,
`tools`, `json` — and nothing else. **No catalog describes `code`.** A sync
that overwrote the capability list wholesale would delete a hand-recorded
`code` from a model that had not changed in any way, and `mesh/coding` would
stop seeing it. The catalog refreshes what it observed; it does not get to
erase what it cannot see.

`is_tee: true` earns `internal`, never `confidential`. It is a vendor asserting
something about itself in a JSON field, nothing has checked an attestation, and
on RedPill the TEE operator is frequently not the vendor you assume — the
`providers` list also contains `chutes`, `near-ai`, `tinfoil` and `secretai`,
and a model naming several gives the caller no way to choose.

## Keeping the registry honest

`providers.default.json` ships **free tiers only, priced at 0** — the one number about a provider
that cannot go stale in a way that lies to you. Paid models are deliberately not shipped: their
prices change without notice, and a stale price does not fail loudly, it silently reorders the
`cheap` profile. Copy `providers.example.json` and fill in prices you have verified yourself.

Model ids and free tiers **do** rot, silently, and the first symptom is a user waiting on a reply.
Turn that into an exit code:

```sh
inferencemesh probe            # calls every candidate once
inferencemesh probe --json     # for a scheduler
```

`probe` separates two findings that look alike and are not: a `404`/`400` means the id is gone and
needs a human (`BROKE`, exit 1), while a `429` means the free tier is working as designed
(`limit`, exit 0). Alerting on the second every night is how a monitor teaches you to ignore it.

`quality` and `languages` scores are hand-maintained relative estimates, not benchmark results.
They only have to order *your* registry correctly. The `languages` half of that can at least be
contradicted by evidence:

```sh
inferencemesh probe --language=ja          # ask in Japanese, grade what comes back
inferencemesh probe --language=ja --json
```

Judging covers the scripts that identify a language on their own — Japanese
(kana, so Chinese is not accepted as Japanese), Chinese, Korean, Russian,
Arabic, Hindi, Thai, Hebrew, Greek, Armenian, Georgian, Bengali, Tamil — plus
eleven Latin-script languages told apart by function words. Anything else is
reported `unjudged` rather than failed.

Where languages share a script, the letters that separate them are checked too:
a Ukrainian reply does not confirm a Russian claim, a Persian one does not pass
as Arabic, and `zh-Hant` is not answered in simplified characters — while plain
`zh` accepts either, because it asked for neither. That check may only reject, never invent — a reply carrying
nothing distinctive keeps the script's verdict, and one carrying two languages'
exclusive letters at once is treated as no evidence rather than a finding. Pairs
with no letter to separate them (Hindi and Marathi) are still not told apart.

Each candidate is asked two questions **written in that language** — an English "reply in Japanese"
instruction would measure instruction-following instead — and the reply is graded by script and
function words. The result is printed next to what the registry claims, and only one direction is a
fault: a language the registry says is served and the model will not answer in (exit 1). A model
rated low that answers fine is reported as `understated`, which is worth reading and nobody's alert.

A run where every candidate was unreachable or rate-limited reports `nothing
was measured`, not `no contradictions` — and `--json` carries a `judged` count
beside `ok`, because `ok: true` over zero measurements is the most misleading
green there is.

**It never writes the score.** Answering in Japanese is compliance, not competence, and turning a
pass into a `0.84` would put an invented number exactly where a measured one belongs — the same
failure as an unverified price. What it cannot judge it says it cannot judge: a language with no
judge, a reply too short to tell apart from its neighbours, and a reply the token budget cut off
mid-thought all come back `unjudged` rather than as a failure. That last one is not hypothetical —
the first live run of this command called a model a Japanese failure while it was, in English,
reasoning about answering in Japanese.

## Finding new providers

New entrants give inference away deliberately — it is customer acquisition, not charity — so the
best free tier available today is often one that did not exist when your registry was written.
A hand-written list is stale the month it ships.

```sh
node scripts/discover-providers.mjs        # exit 10 when there is something new
node scripts/discover-providers.mjs --json
```

It diffs each provider's own `/v1/models` against the last run (catching **removals**, which are
what break your registry, as well as additions) and sweeps Hacker News and starred community lists.
Every source is keyless, because a source that needs a key stops working exactly when you stop
noticing. Findings are candidates: confirm with `probe` before adding anything.

## Providers that need no key at all

A provider may declare `apiKeyOptional: true`, in which case it is loaded even with no credential
and the adapter sends **no** `Authorization` header — an empty `Bearer ` is rejected as malformed by
some gateways, which looks identical to a bad key.

This makes a zero-signup deployment possible: with an empty environment the mesh still routes, using
only the open-tier providers. Such providers are pinned to `maxPrivacy: "public"` in the shipped
registry, and they should stay there — an endpoint anyone can call anonymously is not somewhere to
send anything you would mind being logged.

## Development

```sh
npm test        # builds, then runs the suite (no network, no key)
npm run build
```

Every failure path in the suite is exercised with a deliberately broken input — a malformed
registry, an empty token set, a mid-JSON stream chunk, an expired quota window — because a check
that has never once fired is not known to work.

## License

MIT © GDA Labs
