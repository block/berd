# External Model Providers — Settings Plan

**Status:** In progress — Phase 1
**Linear:** [BOT-1159](https://linear.app/squareup/issue/BOT-1159/external-model-providers-first-class-custom-provider-setup-in-settings)
**Branch:** `external-model-providers`
**Owner:** Morgan (design) + implementing engineer
**Last updated:** 2026-07-06

This is the source of truth for taking the Settings > AI Providers page from
Databricks-only (internal Block builds) to a fully external-ready provider
experience. Update this doc when decisions change, phases complete, or the
plan diverges.

---

## Product intent

Berd is going external. Anyone should be able to connect any LLM to the Goose
harness from Settings, without confusion:

- **Tier 1 — first-class providers**: Anthropic, OpenAI, Google Gemini, and
  Databricks, each with a dead-simple "paste key → verify → done" card.
- **Tier 2 — "Add a provider"**: everything else, via (a) a template catalog
  of ~32 known providers (Groq, OpenRouter, Ollama, DeepSeek, Mistral, LM
  Studio, …) where picking one pre-fills everything except the key, and (b) a
  "Something else" manual form for truly custom endpoints.

The bar: a user holding *any* LLM credentials should immediately know where
they go. Upstream Goose desktop's provider UI is our anti-pattern (see
"Upstream critique" below).

Onboarding integration is a later effort. This work is settings-page only.

## Decisions so far

| # | Decision | Rationale |
|---|---|---|
| 1 | **Ship directly, not as an experiment** | Team decision 2026-07-06. This is the external product surface, not an in-progress toggle. The internal/external split is handled by runtime config (see below), not an experiment flag. |
| 2 | **Keep internal Block Databricks OAuth as-is; no second URL field** | Internal builds inject `DATABRICKS_HOST` via runtime config → env var; UI shows it read-only. External builds omit the injected host and the *same* card shows one editable host field (mechanism already exists — see "What helps"). Either/or, never both. |
| 3 | **Template catalog ships in v1 of Tier 2** | The goose backend provides it nearly free, and it's what makes "advanced" feel effortless. Users with a Groq/OpenRouter/etc. key never see protocol jargon. |
| 4 | **Three custom shapes only: OpenAI-compatible, Anthropic-compatible, Ollama — explicitly NOT Gemini** | Verified 2026-07-06 (second web-research pass + upstream source): the custom-provider `engine` enum in goose is exactly `openai \| anthropic \| ollama`. OpenAI shape is the universal default (Anthropic and Google both ship official OpenAI-compat endpoints). Anthropic shape (`/v1/messages`) has strong third-party adoption via the Claude Code ecosystem (Moonshot/Kimi, Z.AI, DeepSeek, MiniMax, Qwen, OpenRouter, LiteLLM, vLLM). Ollama's native API is a real fourth dialect mimicked by local runtimes (Lemonade, RamaLama) and signals "local, no key, right defaults". Gemini's `generateContent` shape has **no meaningful third-party adoption** — it is used only by the first-class Gemini card (goose's built-in `google` provider); anyone with a Gemini-ish custom endpoint uses Google's OpenAI-compat surface via shape 1. Do not add a Gemini option to the custom form. |
| 5 | **Bedrock / Vertex AI are documented gaps, not built** | Fundamentally different auth (SigV4 / service accounts). Standard mitigation: a hint in the custom form that these work via a LiteLLM/OpenRouter proxy. Azure OpenAI deferrable — upstream has a native `azure` provider we can allowlist later. |
| 6 | **`byoKeyProviders` flips to default-on (opt-out)** | Decided 2026-07-06: Morgan (and internal users generally) must see the BYO surface to iterate on it, and decision #1 says no experiment gating. The flag is now `VITE_BYO_KEY_PROVIDERS !== "0"` — same inverse-positive pattern as `telemetry`/`voiceDictation`. Whether a *restricted internal distro* opts back out (and via which mechanism: build env, runtime-config `featureToggles`, or distro asset) is an engineering/release decision, deliberately left to the packaging owners — see Open Questions. |

## Existing system: what helps

The backend already does almost everything. Berd is a thin UI over goose's
provider APIs.

### Goose backend (pinned via `goose-backend.lock.json`)

- **Provider metadata**: every provider exposes `config_keys` with
  `required` / `secret` / `primary` / `default` / `oauth_flow` flags. Forms
  can be generated entirely from metadata — zero per-provider UI code.
  (Upstream: `crates/goose-providers/src/base.rs`, routes in
  `crates/goose-server/src/routes/config_management.rs`.)
- **Config keys for the Tier 1 providers**:
  - Anthropic: `ANTHROPIC_API_KEY` (required, secret, primary), `ANTHROPIC_HOST`
  - OpenAI: `OPENAI_API_KEY` (secret, primary), `OPENAI_HOST`,
    `OPENAI_BASE_PATH`, `OPENAI_ORGANIZATION`, `OPENAI_PROJECT`, …
  - Google Gemini: `GOOGLE_API_KEY` (required, secret, primary), `GOOGLE_HOST`
  - Databricks (`databricks_v2`): `DATABRICKS_HOST` (required, primary),
    `DATABRICKS_TOKEN` (secret, optional — OAuth is the alternative)
- **Custom providers**: full CRUD, hot-reloaded, keys go to the OS keyring
  (never into the JSON). Schema includes `engine`
  (`openai` | `anthropic` | `ollama`), `base_url`, `models`, `headers`,
  `dynamic_models` (fetch `/v1/models` vs static list).
- **Template catalog**: ~32 bundled provider templates (id, name, format,
  api_url, model list, doc link, key env var). Routes:
  `GET /config/provider-catalog`, `GET /config/provider-catalog/{id}`.
- **Live model fetch** per provider and a **check/verify** endpoint.
- Secrets: OS keyring by default; masked reads.

### Berd frontend (already wired)

- `src/features/settings/ui/ProvidersSettings.tsx` — the page; splits agent
  providers vs model providers; per-provider status chips.
- `src/features/settings/ui/ModelProviderRow.tsx` — expandable row; handles
  field-based setup and native OAuth (Databricks). Contains the hardcoded
  internal-host display mirror (`INTERNAL_DATABRICKS_HOST`).
- `src/features/providers/api/credentials.ts` — ACP
  `GooseUnstableProvidersConfigRead/Save/Delete/Authenticate/Status`.
- `src/features/providers/api/catalog.ts` — setup catalog; currently
  hardcodes BYO providers to `["openai", "anthropic"]`
  (`SETUP_CATALOG_BYO_KEY_PROVIDER_IDS`) — **needs `google` added**.
- `src/features/providers/api/customProviders.ts` — ACP
  `GooseUnstableProvidersCustomCreate/Read/Update/Delete` (already exists!).
- `src/features/providers/runtimeProviderConfig.ts` —
  `mergeRuntimeProviderCatalog`: when runtime config has **no** injected
  `endpointEnv`, it swaps in goose's editable `DATABRICKS_HOST` field. This is
  the internal/external Databricks seam, already built.
- `src/shared/ui/icons/ProviderIcons.tsx` — icons already exist for OpenAI,
  Anthropic, Gemini, xAI, Azure, Vertex, Ollama, Databricks, ….
- ACP surface (SDK, `sdk/src/generated/`): providers list, setup catalog,
  catalog templates, custom CRUD, config read/save, supported-models list,
  inventory refresh. No new ACP methods are expected for this work.

### The internal/external Databricks mechanism (decision #2, in detail)

1. `src-tauri/resources/runtime-config.json` (internal distro) carries
   `endpointEnv: { DATABRICKS_HOST: "https://block-lakehouse-production…" }`.
2. `src-tauri/src/services/acp/goose_serve.rs`
   (`apply_runtime_goose_provider_env`) injects it into the `goose serve`
   process env at spawn. `src-tauri/src/commands/runtime_config.rs` validates
   that only `DATABRICKS_HOST` may appear in `endpointEnv` and that it holds
   no secrets.
3. UI shows the injected host read-only (`InternalDatabricksDetails` in
   `ModelProviderRow.tsx`). Since 2026-07-06 this is gated on the *actual
   injected host from the runtime-config store* (`useInjectedDatabricksHost`),
   not on the build flag — the hardcoded UI mirror of the host was removed.
4. **External path**: when `endpointEnv` is absent,
   `mergeRuntimeProviderCatalog` exposes the editable `DATABRICKS_HOST` field
   from goose's setup catalog + `DATABRICKS_TOKEN` / OAuth. Today this only
   activates in dev via `VITE_BYO_KEY_PROVIDERS=1` +
   `runtime_config_load_result_for_local_byo_dev` (debug builds strip the
   default host). The work is productionizing this path, not building it.

## Existing system: what blocks us

- `byoKeyProviders` is a dev-only build feature
  (`src/shared/profile/buildProfile.ts`, `VITE_BYO_KEY_PROVIDERS`); the
  debug-only runtime-config stripping in `runtime_config.rs` is
  `#[cfg(debug_assertions)]`. External builds need a real distro-level
  runtime config without the injected host, not a dev hack.
- The BYO provider list is hardcoded to openai + anthropic; Gemini
  (`google`) missing.
- No UI exists for the template catalog or the custom-provider form —
  `customProviders.ts` API bindings exist but nothing renders them.
- `ModelProviderRow.tsx` (573 lines) mixes concerns; adding tier-2 flows to
  it directly would recreate upstream's mess. Expect a modest refactor into
  a shared metadata-driven field form used by both tiers.
- No "verify connection" affordance in the current UI; goose has
  `check_provider` and live model-list routes but Berd doesn't surface them.
- No dedicated secret-input primitive — secret fields are inline
  `<Input type="password">`. Acceptable for v1; consider a design-system
  `SecretInput` (masked, reveal toggle, shows set-state) as a follow-up.

## Upstream critique (what not to do)

Upstream Goose desktop (`ui/desktop/.../settings/providers/`) has a clean
metadata-driven form for built-ins and a **separate 950-line wizard** for
custom providers: different vocabulary, hand-typed comma-separated model
lists, a raw "engine" dropdown with no guidance, silently locked fields.
The confusion is client-side, not a backend limitation.

**Our rule: one form system.** Tier 1 cards, catalog-template setup, and the
manual custom form all render from the same metadata-driven field renderer.
The only difference between tiers is how the field values get pre-filled.

## UX direction

### Tier 1 — first-class cards

Anthropic, OpenAI, Gemini, Databricks. Each card/row:

- One visible field (API key; Databricks: host or the read-only internal
  host + OAuth), driven by the metadata `primary` flag.
- "Get an API key →" link out to the provider console.
- **Verify** on save: cheap authenticated call (goose `check_provider` /
  models list) → Connected ✓ / actionable error.
- Non-primary keys (base URL, org ID, project) behind a collapsed
  "Advanced" disclosure — rendered from metadata, not hand-built.
- Status chip: Connected ✓ / Not set up / Error.

### Tier 2 — "Add a provider"

One entry point at the bottom of the provider list. Flow:

1. Searchable list of catalog templates (Groq, OpenRouter, Ollama, DeepSeek,
   Mistral, LM Studio, …) + **"Something else"**.
2. Template picked → same form as Tier 1: pre-filled URL/shape/models, user
   pastes key (or nothing, for local servers), Verify, done.
3. "Something else" → manual form: display name, base URL (smart
   placeholder), optional API key, shape selector defaulting to
   OpenAI-compatible — the three options are OpenAI-compatible /
   Anthropic-compatible / Ollama (matching goose's `engine` enum exactly;
   no Gemini option, see decision #4), each with a one-line plain-language
   description — custom headers under Advanced.
4. **Verify does double duty**: tests connection AND fetches the model list
   (`GET {base}/models` etc.). Manual model-ID entry only as fallback when
   fetch fails.
5. Bedrock/Vertex hint: "Using AWS Bedrock or Vertex AI? Connect through a
   LiteLLM or OpenRouter proxy." (link to docs)

### Error copy (from research; make errors actionable)

- 401 → "That key was rejected — check it in your provider's console."
- 404 on models → "That URL doesn't look right — did you include /v1?"
- Connection refused/timeout → "Can't reach the server — is it running?"
- Normalize URLs: trim trailing slashes, strip accidentally pasted
  `/chat/completions` suffixes (the #1 user error across surveyed tools).

## Options considered

- **Per-provider hand-built forms** — rejected: metadata-driven forms cost
  the same and cover future providers for free.
- **Flat dropdown mixing brand names and protocols** (Cline-style) —
  rejected: the most-cited confusion pattern in the research.
- **Custom = "override the OpenAI base URL"** (Cursor-style) — rejected:
  conflates one provider's settings with the custom concept.
- **Skip the template catalog in v1** — rejected 2026-07-06 (decision #3).
- **Ship behind an experiment** — rejected 2026-07-06 (decision #1).
- **Require manual model entry** (Zed-style, incl. context windows) —
  rejected: auto-fetch with manual fallback (LibreChat's
  `fetch + default` pattern) is strictly better.

## Phased implementation plan

### Phase 1 — External Tier 1 providers (teaches us the risky thing)

Goal: Anthropic, OpenAI, Gemini, and editable-host Databricks working in an
external-shaped build.

1. ✅ (2026-07-06) Add `google` to the BYO provider set in
   `src/features/providers/api/catalog.ts`. Verified against the pinned
   backend: its curated setup catalog serves "Google Gemini"
   (`single_api_key`, docs → aistudio.google.com/apikey); icon already mapped.
2. ✅ (2026-07-06, partially) `byoKeyProviders` flipped to default-on
   opt-out (decision #6). Remaining for engineering: the external distro
   runtime-config asset (no `endpointEnv`) and whether/how restricted
   internal distros opt out — see Open Questions.
   Also done: the internal Databricks read-only host box now keys off the
   injected `endpointEnv` host from the runtime-config store instead of the
   build flag (and the hardcoded host string in `ModelProviderRow.tsx` was
   removed) — so internal builds keep the managed read-only display and
   BYO cards can coexist with it.
3. ✅ (2026-07-06) External Databricks path — already productionized,
   verified rather than built. The release pipeline
   (`scripts/release/build-macos.sh`) already rewrites the
   bundled runtime-config when a build sets `VITE_BYO_KEY_PROVIDERS=1`:
   it strips the injected `DATABRICKS_HOST` via jq and re-validates. So an
   external-shaped release build = custom build env with that var; the
   frontend merge logic then exposes the editable host field. The Rust
   debug-only stripping remains as the dev-mode simulation of the same
   posture. Release defaults: the official internal build passes an
   explicit `0` (internal posture unchanged — engineering owns flipping
   this, see Open Question 1). README updated to document default-on dev
   behavior and the external simulation flag.
4. Extract the metadata-driven field form from `ModelProviderRow.tsx` into a
   reusable unit (this is the seam Phase 2 builds on).
5. ✅ (2026-07-06, partially) Actionable errors + "Get an API key" links.
   The existing save → model-refresh pipeline already *is* verify-on-save
   (one authenticated model-list request validates key + URL + network);
   what was missing was translation of raw failures. Added
   `src/features/providers/lib/connectionErrorHints.ts` (maps 401/403,
   404, connection-refused/timeout/DNS, and 429 signatures to actionable
   i18n hints; unrecognized errors pass through) wired into
   `ModelRefreshMessage`, plus a "Get an API key" link on setup panels
   sourced from the catalog's `docsUrl` (opens via Tauri opener).
   Collapsed rows now show a warning triangle (with accessible label) when
   the post-save verification left a warning, taking precedence over the
   connected checkmark.
6. Validation: internal build regression (Databricks OAuth unchanged, host
   read-only); external-shaped build connects all four providers end to end.

### Phase 2 — Template catalog

Decision (2026-07-06, Morgan): the add/edit flow is a **modal dialog**, not a
sheet — one dialog serves create and edit, so editing an existing custom
provider reuses the identical surface.

Decision (2026-07-06, Morgan): **no upfront choice screen.** Create opens
directly onto the template list; "Fully custom" is a secondary action below
the list, not a fork the user must resolve before seeing their options. The
old choice step (template vs manual) was removed.

1. ✅ Surface `GooseUnstableProvidersCatalogList` / `CatalogTemplate` in an
   "Add a provider" picker (searchable list, engine-compatibility filter).
2. ✅ Template → pre-filled form → save via
   `GooseUnstableProvidersCustomCreate`.
3. ✅ Model fetch on save (via providerModelCacheStore, same path as
   built-in providers); custom providers appear as rows with edit/delete
   (delete behind a ConfirmDialog).

Implementation note: the pre-#291 components were restored from git history
(`CustomProviderDialog/Form/Choice`, `ProviderTemplatePicker`,
`CustomHeadersEditor`, `ProviderModelListEditor`, plus the
`customProvider*` lib layer with its tests and the settings-side form
adapters) and adapted: `useCustomProviders` was rewritten against
`providerModelCacheStore` (the old inventory store is gone), custom-provider
listing now reads `GooseUnstableProvidersList` filtered to
`providerType == "Custom"`, and the whole surface is gated on the
`byoKeyProviders` build feature. The full `providers.custom.*` i18n
vocabulary already existed in en/es.

### Phase 3 — "Something else" manual custom form

1. Manual form on the same shared field renderer: name, base URL, optional
   key, shape selector (default OpenAI-compatible), headers under Advanced.
2. URL normalization + the error copy above; Bedrock/Vertex proxy hint.
3. Manual model-ID fallback when model fetch fails.

### Phase 4 — Polish & ship-readiness

1. Empty/loading/error states across the page; keyboard/focus QA.
2. Model picker integration: models from newly connected providers appear
   correctly in session model selection (check
   `providerModelCacheStore` / `useProviderModels`).
3. Removal flows: disconnecting a provider that owns the active model —
   define fallback behavior.
4. i18n pass (`settings` namespace), copy review.
5. Optional: `SecretInput` design-system primitive.

## Edge cases

- Disconnecting the provider whose model is active in an open session.
- Custom provider with no auth (Ollama/LM Studio) — key field must be
  genuinely optional.
- Model fetch returns nothing / endpoint hides `/models` → manual fallback.
- Duplicate custom providers pointing at the same base URL.
- Internal build + user somehow reaches BYO fields — must be impossible via
  runtime-config validation, not UI hiding alone.
- Keyring unavailable (`GOOSE_DISABLE_KEYRING` plaintext fallback) — backend
  handles it; don't assume keyring in UI copy.
- Legacy migration: existing internal users must see zero change.

## Validation plan

- `just check`, `just test` for frontend phases; `just tauri-check` +
  `cargo test` for any `runtime_config.rs` / `goose_serve.rs` changes.
- Manual QA matrix: internal bundle (unchanged), external-shaped build
  (all four Tier 1 + one catalog template + one manual custom, verify,
  chat with each), failure paths (bad key, bad URL, unreachable local
  server).
- Existing tests to watch: `catalog.test.ts`,
  `runtimeProviderConfig.test.ts`, `ModelProviderRow.test.tsx`,
  `customProviders.test.ts`, runtime-config Rust tests.

## Open questions

1. **(Engineering/release decision)** Internal vs external distro posture:
   (a) the external bundle's runtime-config asset (no injected
   `endpointEnv`), and (b) whether restricted internal distros should hide
   BYO providers, and via which lever — `VITE_BYO_KEY_PROVIDERS=0` at build
   time, a new runtime-config `featureToggles` key (would need adding to
   `RUNTIME_FEATURE_TOGGLE_KEYS` + the Rust validator), or a separate
   `distro/` asset set. Deliberately not decided in design; the default-on
   flag works with any of these. (See `docs/release-and-updates.md`.)
2. Does the pinned goose backend expose the provider-catalog routes over
   the ACP surface Berd uses (`GooseUnstableProvidersCatalogList` exists in
   the SDK — confirm it's implemented in the pinned backend build)?
3. Should Tier 1 Gemini use goose's `google` provider only, or also surface
   `gemini_oauth`? Default: `google` (API key) only for v1.
4. What happens to `defaultModelProviderId`/`defaultModelId` in an external
   build with nothing configured — first-run empty state is an onboarding
   question, but settings needs a sane "no provider yet" state now.

## Progress log

- **2026-07-07** — Dialog system consolidation (commit 9705ff63). Driven by
  the modal audit (Figma "Modals" page, node 387-435): an 8-system web
  survey (M3, Atlassian, Polaris, Carbon, Primer, Apple HIG, Geist, Radix)
  found no mature system ships a separately-named "structured/form dialog" —
  the anatomy belongs in the one Dialog. So: `EditDialog` deleted;
  `Dialog` gained `size` (md/lg/xl) and `DialogBody` (opt-in scroll zone
  that auto-pins header/footer via `has-data-[slot]` selectors, `asChild`
  for form bodies); all dialogs now share the glass surface; taxonomy
  (Dialog / AlertDialog / ConfirmDialog / CommandDialog) + RowButton rule
  documented in `src/shared/ui/AGENTS.md`. CustomProviderDialog rebuilt on
  the zoned anatomy: RowButton template rows (no icons, bg-muted hover),
  search/filter seated into list chrome, pinned fully-custom action.
  Follow-up PR (Morgan): migrate remaining hand-rolled modals
  (ExtensionModal, WorkspaceCreateDialog, SecurityConfirmationModal, …)
  onto the zoned Dialog and rename `*Modal` → `*Dialog`.

- **2026-07-06 (late pm)** — Shape research correction: second web-research
  pass confirmed the custom shapes are OpenAI/Anthropic/Ollama, **not**
  Gemini (decision #4 rewritten with evidence). Verify-on-save clarified:
  the existing post-save model refresh is the verification call; added
  connection-error hint mapping (`connectionErrorHints.ts` + tests + en/es
  strings) and "Get an API key" docs links on setup panels. Also found that
  Berd previously had custom-provider UI (CustomProviderForm/Dialog/Choice,
  removed in #291) and the full `providers.custom.*` i18n vocabulary
  (engines, templates, fields) still exists in en/es — Phase 2/3 can reuse
  those strings.
- **2026-07-06 (pm)** — Phase 1 started on branch `external-model-providers`:
  `google` added to BYO set (+test); `byoKeyProviders` flipped to
  default-on/opt-out (`VITE_BYO_KEY_PROVIDERS !== "0"`, tests updated);
  internal Databricks read-only host display re-keyed from build flag to the
  actual runtime-config `endpointEnv` value (`useInjectedDatabricksHost`),
  removing the hardcoded host mirror. `just check` + focused vitest green
  (one pre-existing unrelated ChatInput.skills failure on main).
  Linear: BOT-1159 created, In Progress.
- **2026-07-06** — Research completed (web survey of 9 tools, upstream Goose
  backend + desktop UI, Berd codebase audit). Direction approved by Morgan:
  ship directly (no experiment), keep internal Databricks OAuth via
  runtime-config injection with the existing editable-host fallback for
  external, include template catalog in v1. This doc created as source of
  truth. No implementation yet.
