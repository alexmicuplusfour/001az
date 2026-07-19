# AI provider rate limiting — parity with connectors (2026-07-19)

Bring AI providers up to the rate-limit contract **connectors already have**, so tagging /
extraction / embedding / transcription calls are paced per API key instead of firing
unthrottled. Foundation for `worker-pools-plan.md`: that plan's "AI budget" should *read*
these limits, not invent a number. Retires the last excuse for `TAG_CONCURRENCY=4` being the
only thing standing between the worker and a provider 429.

## The gap (evidence)

- **Connectors declare and enforce rate limits as a first-class plugin property.**
  `connectorDefs()` puts `rpm`/`burst` in every connector's `configSchema` (editable on the
  Plugins page, stored in `plugins.config`); `activeProvider()` shallow-merges the override
  onto the descriptor (`{ ...raw, rpm: st.config.rpm ?? raw.rpm, ... }`); `callProvider()`
  reads `provider.rpm`/`provider.burst` and runs the call through a per-provider **token
  bucket** (`acquire`) in `connectors/runtime.js`. Provider modules ship defaults
  (`coingecko rpm 25`, `financialmodelingprep rpm 60`, …).
- **AI providers declare nothing and enforce nothing.** `aiDefs()` has `configSchema: []`.
  The descriptors (`anthropic`, `openai`, … in providers.js) carry models/embeds/transcribes
  but **no `rpm`/`burst`**. The call path is `withPluginHealth(() => callTagger())` →
  `wire.tag()` — **health telemetry but no pacing layer.** The only throttle on AI calls today
  is the worker's global `4`.
- Net: every board's tagging/extraction fires as fast as the worker claims, and on a briefly
  throttled key the audit's "4 parallel fails + instant retries sustain the 429" (§2) is the
  result. `retry_at` cleans up *after* a 429; nothing prevents it.

## Design — mirror the connector path, with two AI-specific twists

Insert a **pacing layer** between the health ledger and the wire, exactly where connectors
have theirs:

```
withPluginHealth( callTagger[ acquire(bucket, rpm, burst) → wire.tag ] )
        health    ∘            pace                        ∘  wire
```

- **Shared token-bucket primitive.** Lift `acquire` (+ its `buckets` Map) out of
  `connectors/runtime.js` into a neutral `server/provider-pacing.js`. Both connectors and the
  AI wire import it; providers.js must not depend on the connector layer. One `buckets` Map,
  namespaced by the caller's key string, so keyspaces never collide (connector key = provider
  name; AI key = `ai:<provider>:<keyhash>`).
- **Twist 1 — bucket per API key, not per provider.** Connectors bucket by provider name (one
  key per connector). AI limits are per *account/key*: two boards with different keys have
  independent limits; two sharing one key contend. So the bucket key hashes the apiKey
  (`ai:<provider>:<sha1(apiKey)[:12]>`); the env fallback key (`ANTHROPIC_API_KEY`) buckets the
  same way. Config (`rpm`/`burst`) is declared at the **provider** level; the **bucket** is
  per key using that provider's rate.
- **Twist 2 — pace, don't retry.** Connectors do `acquire().then(withRetry)`. AI must NOT add a
  retry loop: §2 settled that the Anthropic SDK already retries twice and the queue's spaced
  `retry_at` is the retry mechanism — layering `withRetry` would double-retry Anthropic. So the
  AI path is `acquire()` **only**; failures fall through to the existing classifier. This is a
  deliberate divergence from the connector template, and the right one.
- **On-device providers bypass.** `local` (Xenova embeds) and `whisper` (sidecar) are keyless,
  on-device — CPU/concurrency-bound, not rate-bound. `embedTexts` already branches `local`
  before the wire; whisper never routes through `transcribeAudio`. So pacing naturally only
  touches the networked, keyed providers. (Their concurrency belongs to the worker-pools plan.)

## Slices

- **Slice 1 (done) — mechanism + REQUIRED, researched limits.** Shared `provider-pacing.js`;
  connectors re-pointed at it (behavior-preserving); `callTagger`/`embedTexts`/`transcribeAudio`
  `acquire` per key; **every keyed provider declares `rpm`/`burst` in its descriptor, enforced by
  `requireRateLimit`** — built-ins at import, external plugins at `registerProvider`, so a networked
  provider can't enter the registry unthrottled (keyless local/whisper exempt). Values are grounded
  per provider (table below). `AI_RPM`/`AI_BURST` env override (mirrors `CONNECTOR_RPM`), unthrottled
  in the test harness. A `DEFAULT_AI_RPM` remains only as a defensive fallback, unreachable for a
  validated provider.
- **Slice 2 (done) — editable in the Plugins UI.** `aiDefs()` exposes `rpm`/`burst` in
  `configSchema` for networked providers (keyless get none); a `pacingSection` on the AI card
  renders + saves them via the generic PATCH route. The override is read **per provider** by the
  worker's `aiRate` helper (`pluginState('ai:<provider>').config`) and threaded to `paceAi` through
  the dispatchers, so it reaches tagging, extraction, embedding, and transcription. Precedence: env
  `AI_RPM`/`AI_BURST` > admin override > descriptor default. NOTE: config is per-**provider** (like
  connectors), applied to each key's own bucket — not literally per-key, so two keys of one provider
  on different tiers share the setting. True per-key config is a later refinement.
- **Slice 3 — worker-pools handoff + TPM.** The pools' AI budget consumes these limits instead of a
  constant, and adds **tokens-per-minute** awareness — the real ceiling for image/document tagging
  (Anthropic's Start tier is 1,000 RPM but 2M ITPM; a req/min bucket alone can't see it).

## Researched limits (2026-07)

Each descriptor's `rpm`/`burst` and its basis. **RPM is a burst guard; TPM is the true ceiling
(slice 3).** Users override per key for their tier.

| Provider   | rpm / burst | Basis |
|------------|-------------|-------|
| anthropic  | 1000 / 50   | "Start" (entry paid) tier, Haiku 4.5 — **published** (2M ITPM is the real cap) |
| openai     | 500 / 25    | Tier 1 ($5), gpt-4o/mini-class chat — **published** (free tier is only 3 RPM) |
| gemini     | 10 / 5      | **Free** tier, 2.5-flash — **published**; paid Tier 1 ~1000+, raise per key |
| glm        | 60 / 2      | **Not published** — Z.ai gates by concurrency (~1-2 in flight); conservative choice, low burst |
| openrouter | 60 / 10     | **Not published** for paid (credit/DDoS gated); free models are 20 RPM; conservative |
| local, whisper | — | on-device / keyless — exempt (no external limit) |

Honest note: only anthropic/openai/gemini are grounded in a published provider figure; glm and
openrouter don't publish an RPM (concurrency- / credit-gated), so those two are conservative
engineering choices, flagged as such in the code comments.

## Interactions / risks

- **§2 retry philosophy:** pace-only, no `withRetry` — verified above. No behavior change to the
  classifier; a paced call that still 429s rides the existing spaced `retry_at`.
- **Single-flight sleeps:** an empty bucket makes `acquire` sleep inside the current single-flight
  tick (the runtime.js caveat). The loose default rarely engages; once worker-pools lands, the
  sleep moves off the critical path into its lane. Note-only until then.
- **Health ledger order:** pacing sits inside `withPluginHealth`, so a paced call's outcome still
  lands on the Plugins dot. A pure wait (no failure) records nothing — correct.
- **Compose passthrough:** `AI_RPM`/`AI_BURST` (and the eventual per-provider config) must reach
  the container — the §5 lesson that unreachable knobs are dead knobs. Part of Slice 1/2, not an
  afterthought.

## Tests (test/provider-pacing.test.js, no DB)

- **Bursts then paces:** `acquire(k, 600, 2)` → first 2 immediate, 3rd waits ~100 ms.
- **Independent buckets:** draining key A doesn't delay key B's first acquire.
- **Wiring:** a fake provider declaring `rpm 600 / burst 1`; three concurrent
  `callTagger({provider, apiKey:k1})` start ~100 ms apart (paced), while a `k2` call runs
  unblocked — proves per-key pacing off the DECLARED limit.
- **Contract:** `registerProvider` throws for a networked provider with no `rpm`/`burst`; a keyless
  one is exempt.
- **Regression:** full suite green — helpers.js sets `AI_RPM`/`AI_BURST` huge so DB-backed tests
  don't wait on the declared limits.
