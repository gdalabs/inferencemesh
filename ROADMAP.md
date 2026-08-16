# Roadmap

## Now

- **Per-provider concurrency limits.** The ledger counts requests per minute but
  not how many are in flight. Coding agents fan out, so a provider that allows
  one concurrent request returns a burst of 429s. Measured: the same agent task
  ran 6 attempts with 3 failures against a single provider, and 3 attempts with
  0 failures once a second provider was available. More candidates hide it; a
  semaphore would fix it.
- **Measured language competence.** `languages` scores are hand-written
  estimates today, which does not scale to a generated registry and is the wrong
  way round for non-English users — the thing that matters most is the thing
  being guessed. `probe --language=ja` could measure whether a model actually
  replies in the requested language and feed that in.
- **Prebuilt binaries.** `npm run build:binary` produces a working executable,
  but one platform at a time. CI should build macOS arm64/x64, Linux x64/arm64
  and Windows, publish them to Releases, and back an `install.sh`.

## Next

- **Generated registry.** `providers.default.json` is hand-maintained and covers
  a fraction of what is reachable: six public catalogs list ~630 models. A `sync`
  command could generate entries per provider, with a policy for whether that
  provider's whole catalog is free, instead of curating model by model.
- **Publish what discovery finds.** `scripts/discover-providers.mjs` reports to
  whoever runs it. The information gap it addresses is public, so the output
  should be too.
- **KV-backed ledger for Workers.** The in-memory default resets with the
  isolate, which under-counts against daily caps.
- **Tool calling for the Gemini adapter.** OpenAI-compatible providers pass tools
  through today; the native Gemini adapter does not translate them yet.
- **Embeddings and rerank.** Present in the capability type, absent from adapters.

## Non-goals

- **Automatic fallback to paid models.** Exhausted free tiers return an error.
  Someone learning on a free tier must not be able to turn a mistake into a bill.
- **A hosted service that holds your keys.** Keys stay on the machine that runs
  the gateway. There is no server-side component and no `get` on `KeyStore`.
