# NEXT — inferencemesh

## Current handoff

The repository is public. See the dated checkpoints below for test counts and
release state; older references to private visibility describe those checkpoints.
All internal notes are maintained in English. The web setup page is English-only;
the terminal wizard supports English, Chinese, and Japanese.

## Pending decisions and work

- Probe the 18 unregistered free OpenRouter models before admitting them. A model
  appearing in the catalog is not proof that its free tier works. Probes requiring
  account quota need the operator's authorization.
- The sample environment template is outdated: NVIDIA/ZAI/MODELSCOPE/OVH/LLM7 and
  KEYS/LEDGER/PUBLIC_HEALTH settings are missing. The secrets hook blocks commands
  naming that template. Leave it to the operator; do not bypass the hook.
- Hindi and Marathi remain indistinguishable by script alone; vocabulary would be
  needed. Belarusian is not distinguished from Ukrainian because `be` has not yet
  been requested.
- Hebrew, Greek, Armenian, Georgian, Bengali, and Tamil can be detected, but their
  probe prompts are in English. This measures instruction following. Do not invent
  prompts in languages that cannot be independently reviewed.
- Measure remaining `maxConcurrent` limits rather than guessing. The llm7 limit of
  1 was reproduced three times on 2026-08-22. Other providers require permission to
  spend their quota. OrcaRouter uses a free but account-gated daily allowance.
- Remaining catalog readers: NVIDIA, Chutes, ModelScope, OVHcloud. OpenRouter's
  reader is implemented and keyless.
- Run language probes for additional languages and compare with registry claims.
- Design a representation for request-size limits. OrcaRouter's measured context
  floors use ASCII; other scripts may hit the byte limit earlier.
- OrcaRouter free access is stopped by `err_free_access_denied` (`retryable:false`).
  Repeated requests cannot fix this. The operator must address the GitHub account
  integration under console profile settings, then re-probe the remaining models.
- The operator still needs to configure Cloudflare account credentials and the
  Mistral key before live probes. Do not read credential files as part of handoff work.
- Masking needs a successful live chat retry after provider recovery. llm7 returned
  502/503 and OpenRouter returned 429; short probes succeeded but full chat did not.
- Port 8910 was already occupied during live testing. Use an available port such as 8919.

## Autonomous session 2026-08-22

Found and fixed first-run failures in the npm package, standalone executable,
container, and installer. Also measured llm7 concurrency and added checks against
silent documentation drift. At this checkpoint, 30 commits were pushed and 331
checks passed on Node 20 and 22. The repository was still private.

Validation included a fresh clone and `npm ci`, a clean build, a healthy Docker
container, packing/installing into an empty project, executable/import/type checks,
four official OpenAI SDK paths, and five installer paths using local distributions.

Files covered the CLI, setup, server, ledger, config, registry, sync, catalogs,
language probe, gateway, mesh, probe reporting, versioning, Worker example,
Dockerfile, installer, package metadata, registry, CI, documentation, and nine tests.

Decisions:

- Recorded `maxConcurrent=1` for llm7 after three reproductions without using an
  account's free quota; other providers await authorization.
- New providers created by sync default to `public`, not `internal`; privacy is a
  human decision.
- Did not author unreviewable native-language probe prompts.
- Did not bypass the secrets hook for the environment template.

At the checkpoint, the release workflow had never run because no tag existed.
Public visibility and the first tagged release still needed approval; both were
subsequently completed as recorded below. No paid quota was requested or used.

## Completed engineering work

- Official OpenAI SDK checks covered models.list, completion, streaming, and
  error classification (`bd57c0f`). Added required model `created` metadata (`03d92f9`).
- Added an executable `version` command (`28112b4`).
- Syntax-checked setup's inline script; a blank HTTP 200 page otherwise passed all
  tests. Confirmed the check catches an intentionally broken script (`75e0508`).
- Documented three missing route flags and tested documentation drift (`37274a9`).
- Changed new sync providers from internal to public privacy (`7a7cd23`).
- Replaced an untypeable Worker snippet with a compiled example, tied it to README
  checks, and caught the corresponding Docker failure (`8209422`, `9ed67ac`).
- The pre-publication audit at that checkpoint checked all 50 author/committer
  records, history, test-key placeholders, and 58 tracked files with no binaries.
- Measured llm7's concurrency limit rather than inferring it (`b646431`).
- Documented eight missing environment settings and added drift checks (`dc45ac9`).
- Fixed ledger load failures being cached forever and piped output being lost by
  process.exit (`aedbca8`).
- Replaced raw startup stack traces for port conflicts and silent fallback on an
  invalid registry override (`c480e8c`).
- Terminal setup now asks for the Cloudflare account ID as well as its key (`53aba28`).
- Fixed bin/exports/types paths from nonexistent locations to dist/src; verified
  pack, clean install, CLI, import, and type resolution (`524c723`).
- Validated CLI/gateway inputs: unknown profiles, invalid privacy/capabilities,
  and NaN minimum context. Invalid gateway profiles return 400, not 500 (`ef46158`).
- Required signup steps for shipped registry providers (`fde1dc8`).
- Fixed concurrent key saves losing one update; confirmed the regression test fails
  when the fix is reverted (`d7f96f4`).
- Corrected token estimation for scripts for which four characters per token
  undercounted usage by about fourfold (`e6a16e4`).
- Gemini now explicitly rejects unsupported json_schema output so the mesh can
  fall back rather than silently ignoring the format (`59eeadc`).
- Enforced no Node-only imports reachable from the portable entrypoint; verified
  the guard catches an intentional violation (`fe9ec63`).
- Surfaced expiry notices in probe/route, not only during registry sync (`549b3fa`).
- Distinguished simplified/traditional Chinese while allowing either for `zh` (`8bfacf7`).
- Expanded key-redaction checks and removed stale test counts (`b7b929a`).
- Validated capability/privacy names, language score ranges, expiry dates, and
  default profiles (`4ec93a8`).
- Fixed an unauthenticated Docker health check and a read-only key-storage path;
  reproduced both in a built container (`befb413`).
- Made the installer fail closed when checksums cannot be fetched or an entry is
  missing; fixed EXIT status and executable permissions. Exercised five local
  distribution paths (`80ec571`).
- Fixed discovery's empty catalog destroying the baseline, all-reader failures
  reporting success, and piped output truncation (`2d474ac`).
- Fixed ledger concurrency that admitted three requests with rpm=2 (`913c525`).
- Fixed setup ENOENT in bundled/standalone builds, existing environment-file
  permissions, and blank lines introduced by repeated saves (`71e142c`).
- Kept gateway access values out of non-TTY logs. Tested that setup fetches no
  external host, uses a URL fragment, and never stores keys in browser storage (`ebd6569`).
- Corrected shared-script language judgments: distinct Ukrainian/Russian and
  Persian/Arabic characters can refute a claim; ambiguous mixed text supplies no
  evidence (`e129ebf`).
- Added six script detectors using a shared range table to avoid divergent
  handwritten counters (`877c369`).
- Probe reports now use attempt metadata, distinguish unclaimed languages from
  faults, and never claim success when nothing was measured. Moved pure logic out
  of the CLI into probe-report.ts (`16aad73`).
- Added push/PR Node 20/22 tests and bundle smoke checks, eliminating tag-only
  verification. Removed keyless-provider dependence and swallowed pipeline errors
  from the smoke step (`89a7b9c`).
- Added a keyless free-only OpenRouter reader and expiry handling, including timed
  pricing overrides (`995fed1`). Sync preserves capabilities a catalog cannot express.
- Added offline-testable `probe --language=<tag>` (`517b9ba`).
- Disabled OpenRouter's gpt-oss-20b free entry after its probe returned 404.

## OrcaRouter handoff completed — 2026-08-27

Completed the 2026-08-25 handoff in `2df6524`, `6ef92c0`, and `279db5a`.
Registered deepseek/deepseek-v4-flash-free, qwen/qwen3.8-27b-free, and tencent/hy3-free
after testing text, tool_calls, and json_object. Generated code was executed with
Node; Tencent's truncated answer was unjudged, so it was not marked code-capable.

Excluded `orcarouter/free`: its undisclosed router resolved to deepseek-v4-flash in
one observation, but providers can change per request, preventing reliable privacy,
capability, or context claims. The same policy excludes anonymous stealth models.

Measured findings:

- 10 requests/minute and 50/day belong to the account, not each model. Added
  ProviderConfig.quota, reserving the account first and refunding it if model
  admission fails. A live server rejected request 11 as account rpm 10/10 and also
  blocked a different model on that key.
- Catalog pricing exposed only a flat request price, not token prices. No
  CatalogSource was added because free token usage could not be established.
- Qwen advertised 65536 context but the free tier returned 400 around 56k.
  The cap is request-size based: identical text was billed as 55,803 / 30,339 /
  30,268 prompt tokens across models. Recorded ASCII floors are not universal.

Cleanup (`83088a5`): documented both quota layers in the example registry, added
OrcaRouter to concurrency work and request-size limits to ROADMAP, and recorded
thinking-model truncation. Fixed Docker's missing translated README copies: tests
had failed since `6c05344`; this was the third documented copy omission.

Remaining: unmeasured OrcaRouter concurrency, language/quality ratings (neutral
DEFAULT_QUALITY_SCORE), and a request-size limit design. Its 50/day allowance means
a concurrency test needs a dedicated day without other tests using that allowance.

## Session 2026-09-05

- Switched the development agent to the free MuseSpark configuration. Permission
  settings took effect after restart.
- Rebased probe-reply-budget onto origin/main and incorporated pending changes;
  388 tests passed, up from 366.
- Upgraded checkout/setup-node to v5; artifact actions remained on their current v4.
- First release workflow completed for v0.1.0-rc.1: five binaries plus checksums.
  Replaced a flaky 50ms server-stream sleep with polling after rerunning the job (`29dc0c2`).
- Verified Cloudflare OpenAI compatibility; account ID remained outstanding.
  Excluded SambaNova after a 402 showed its free tier had been withdrawn.
  Mistral Experiment remained available, with key acquisition left to the operator.
- Disabled Qwen after it vanished from both catalog and free-package endpoints
  (`58ccefb`), removed it from OrcaRouter discovery, and regenerated model docs.
- Unprobed candidates: inclusionai/ling-3.0-flash-sante:free, llm7's
  gpt-5.5-openai-compact/gpt-6-astra, and OrcaRouter's z-ai/glm-5.3-flash-free.
- OrcaRouter's account gate prevented probing even its remaining two models.

## Sessions 2026-09-16–17 — public distribution

- Published the repository after checking tracked files and history for leaked
  credentials. Keyless llm7 inference succeeded; other provider checks avoided
  inference quota. OpenRouter catalog access and Cloudflare credential validation
  succeeded, while OrcaRouter free access remained gated.
- Installed the public binary unauthenticated into a temporary directory and
  verified its checksum. Keyless route free offered only llm7/minimax-m2.7.
- Cloudflare credentials existed only in process environment at that checkpoint;
  the operator still needed persistent CLI configuration.
- Fixed Docker tests failing because scripts/ and docs/ were not copied (`d22c445`).
  Checked version, keyless routing, and live llm7 inference in a clean container.
- Listed InferenceMesh on gdalabs.dev. Its production source is a manual Cloudflare
  Pages deployment (gdalabs-website), not GitHub Pages. Explicit branch main selects
  production; omitting the branch produced a preview in that workflow.

## Sessions 2026-09-17 — masking

- Implemented local term masking using [[IMESH-E1]] aliases and local restoration.
  A failed restoration reduces quality without sending the original terms. Seven
  new tests brought the suite to 395 (`d15716f`).
- Recorded later work for distributing questions across independent providers and
  merging locally; decoy requests remain opt-in because they consume quota.
  Provider collusion, the omniscient merge point, and question visibility limit
  what this design can promise.
- The staging guard falsely flagged a word in source; renamed identifiers and
  comments to sensitive/terms, with no actual key present.
- Implemented body.mesh.mask through the gateway, preserving aliases on fallback.
  Streaming plus masking returns 400. Six new tests brought the suite to 401 (`d0d80cb`).
- Documented masking in all four README translations (`98491d5`). It hides literal
  terms but not structure, topics, or facts. Live restoration remains unverified
  because of provider outages and rate limiting; unit checks are passing.
