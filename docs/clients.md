# Putting the mesh behind a coding CLI

Measured on 2026-08-28 against a gateway started from this repository. Every
result below was produced by running the client, not by reading its docs —
which matters, because two of the three popular CLIs **cannot** talk to this
gateway today, and neither of them says so until you try.

| Client | Works | What it needs |
|---|---|---|
| [OpenCode](https://opencode.ai) | **Yes** — verified | `/v1/chat/completions` |
| Any OpenAI-compatible client or SDK | **Yes** | `/v1/chat/completions` |
| [Codex CLI](https://github.com/openai/codex) | **No** | `/v1/responses` — not implemented here |
| [Claude Code](https://code.claude.com) | **No** | Anthropic `/v1/messages` — not implemented here |

The gateway serves `/v1/models` and `/v1/chat/completions`. That is the whole
OpenAI surface it implements, and the table is a direct consequence.

## Start the gateway

```sh
export INFERENCEMESH_TOKENS=$(openssl rand -hex 32)
docker compose up          # or: inferencemesh serve
```

It binds `127.0.0.1:8910`. Every example below assumes that address and uses
one of your `INFERENCEMESH_TOKENS` as the API key — the clients call it an API
key, but it is the gateway's own token, never a provider key. Provider keys stay
on the machine and no endpoint can read them back.

Check it before configuring anything:

```sh
curl localhost:8910/v1/models -H "authorization: Bearer $INFERENCEMESH_TOKENS"
```

## OpenCode — works

`opencode.json`, in the project or at `~/.config/opencode/`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "inferencemesh": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "InferenceMesh",
      "options": {
        "baseURL": "http://127.0.0.1:8910/v1",
        "apiKey": "{env:INFERENCEMESH_TOKEN}"
      },
      "models": {
        "mesh/free":  { "name": "mesh/free — cheapest that can do the job" },
        "mesh/best":  { "name": "mesh/best — highest rated that fits" },
        "mesh/fast":  { "name": "mesh/fast — lowest observed latency" }
      }
    }
  },
  "model": "inferencemesh/mesh/free"
}
```

```sh
opencode run "explain this repo"
```

Two things that cost time when they are not written down:

- **`npm` must be `@ai-sdk/openai-compatible`.** `@ai-sdk/openai` speaks
  `/v1/responses`, which this gateway does not serve.
- **The first run is slow and silent.** OpenCode fetches that package before it
  does anything, and prints nothing while it does. It looks like a hang; it is
  not. `--print-logs` shows what is happening.

The model reference is `inferencemesh/mesh/free` — provider, then a model id
that itself contains a slash. That parses correctly, and it is worth knowing
that the mesh profile ids are shaped this way before you debug a config that is
already right.

## Codex CLI — does not work today

Codex needs the Responses API. Its own error is the clearest statement of the
situation, and it arrives at config-load time:

```
Error loading config.toml: `wire_api = "chat"` is no longer supported.
How to fix: set `wire_api = "responses"` in your provider config.
```

Setting `responses` gets you as far as a request, and then:

```
ERROR: unexpected status 404 Not Found: no route for POST /v1/responses
```

with five reconnection attempts before it gives up. So there is no configuration
that works — this is a gap in the gateway, not a mistake in the config. The
config that *would* work, once `/v1/responses` exists:

```toml
model = "mesh/free"
model_provider = "inferencemesh"

[model_providers.inferencemesh]
name = "InferenceMesh"
base_url = "http://127.0.0.1:8910/v1"
env_key = "INFERENCEMESH_TOKEN"
wire_api = "responses"
```

## Claude Code — does not work today

Claude Code speaks the Anthropic Messages API. `ANTHROPIC_BASE_URL` moves where
it sends that traffic; it does not change the shape of it, and there is no
OpenAI-compatible mode. Pointed at this gateway:

```
There's an issue with the selected model (mesh/free).
```

and `POST /v1/messages` returns 404, which is the whole story. Bedrock, Vertex
and Foundry are the supported alternatives to the first-party API — all three
are Anthropic-shaped too.

If you want this to work, the gateway needs `/v1/messages`: request and response
translation, not just a route. Until then, use Claude Code with Anthropic and
use the mesh for everything else.

## Anything else OpenAI-shaped

Point it at `http://127.0.0.1:8910/v1` with the gateway token as the API key.
The official `openai` SDKs work unmodified, including streaming:

```python
from openai import OpenAI
client = OpenAI(base_url="http://127.0.0.1:8910/v1", api_key=TOKEN)
client.chat.completions.create(model="mesh/free", messages=[...])
```

Ask for a `mesh/*` profile rather than a specific model and the router picks per
request; name a concrete model and it is pinned, subject to the privacy filter.

## What a client cannot do

- **`mesh/*` is not in any client's model catalog**, so tools that validate
  model names against a hardcoded list will complain. OpenCode accepts whatever
  the config declares. Claude Code warns about the context window it assumes for
  an unrecognised model, which is a real caveat even where it does work.
- **The free tiers are the free tiers.** A coding agent that fans out dozens of
  calls will exhaust a daily quota faster than a chat client will, and the mesh
  answers with an error rather than falling back to a paid model. That is
  deliberate; see the non-goals in [ROADMAP.md](../ROADMAP.md).
