---
feature_ids: [F004]
topics: [models.dev, catalog, provider-import, provenance, tdd, api, ui]
doc_kind: plan
created: 2026-08-06
---

# F004 Models.dev Catalog and Runtime-Safe Provider Import — Implementation Plan

## Finish Line

P1 is complete when an isolated CAFF instance can load a verified vendored models.dev snapshot, normalize provider/model overrides through explicit allowlists, project env names without values, keep catalog cache separate from `models.json`, and let an operator explicitly import a reviewed provider entry through the existing persistence path. Existing provider CRUD, secret masking, configured-model catalog behavior, and Redis/data boundaries remain green.

## Existing Worktree and Baseline

- Worktree: `E:\pythonproject\caff-models-dev-catalog`
- Branch: `feat/models-dev-catalog`
- Baseline: `origin/main@092938a`
- Development Redis: `redis://localhost:6398`
- Production Redis `6399` and production user data are out of scope.

## Terminal Contracts

The normalized domain contract is independent of the upstream wire shape:

```ts
type CatalogProvenance = {
  kind: 'vendored' | 'online';
  sourceUrl: string;
  commitSha?: string;
  etag?: string;
  payloadSha256: string;
  fetchedAt: string;
};

type CatalogModel = {
  id: string;
  name?: string;
  providerOverride?: Record<string, unknown>;
  modalities?: unknown;
  reasoningOptions?: unknown;
  cost?: unknown;
  limit?: unknown;
  family?: string;
};

type CatalogProvider = {
  id: string;
  name?: string;
  env: string[];
  providerDefaults?: Record<string, unknown>;
  models: Record<string, CatalogModel>;
};

type ModelCatalogDocument = {
  schemaVersion: 1;
  provenance: CatalogProvenance;
  providers: Record<string, CatalogProvider>;
};

type ImportProjection = {
  providerId: string;
  modelId: string;
  caffDialect?: 'openai-responses' | 'openai-completions' | 'anthropic-messages' | 'google-generative-ai';
  family?: string;
  familyStatus: 'mapped' | 'unclassified';
  env: Array<{ name: string; kind: 'key' | 'parameter'; required: boolean }>;
  manualConfigurationRequired: boolean;
  catalogMetadata: Pick<CatalogModel, 'modalities' | 'reasoningOptions' | 'cost' | 'limit'>;
  provenance: CatalogProvenance;
};
```

`caffDialect` is intentionally optional in the projection. The importer must not invent a dialect for an unknown provider. The exact upstream parser may retain additional raw metadata in the cache, but only the normalized projection above crosses into the UI/import API.

## Cross-Layer Data Flow

```text
assets/model-catalog.json (verified vendored snapshot)
        -> schema/provenance validator
        -> provider defaults + model override merge
        -> dialect allowlist + env key allowlist + family map
        -> read-only catalog projection API
        -> provider-editor review/import UI
        -> explicit user save
        -> model-provider-persistence -> models.json
```

Catalog discovery must never call `readModelProviderDocument` as a write-through shortcut. The cache is replaceable metadata; `models.json` is the user configuration source of truth.

## Implementation Dependency Chain

1. Snapshot contract and provenance fixture.
2. Parser/schema and deterministic override merge.
3. Dialect, env, and family allowlists.
4. Cache read/write isolation and precedence projection.
5. Controller read/import endpoint with existing CSRF/local-admin guards.
6. Provider-editor import flow and honest metadata/control sections.
7. Full quality gate, fresh-context scan, cross-family review, and isolated acceptance evidence.

## Task 0: Kickoff Documents and Source Blocker

- Land F004 feature, discussion, and this plan; update `BACKLOG.md`.
- Record the current official-source TLS failure as an open blocker.
- Do not add a guessed snapshot, commit SHA, or payload hash.

## Task 1: Catalog Schema and Provenance — RED → GREEN

**Likely files:** `server/domain/models/models-dev-catalog.ts`, `tests/runtime/models-dev-catalog.test.js`, `assets/model-catalog.json`, `assets/model-catalog.LICENSE`, `assets/model-catalog.SOURCE.md`.

- RED: reject missing schema version, providers, model IDs, invalid provenance, duplicate IDs, oversized/count-invalid payloads.
- GREEN: implement normalized schema validation and immutable provenance projection.
- Add the verified vendored asset only after official retrieval succeeds; test payload hash and source declaration.

## Task 2: Override Merge, Dialect, Env, and Family Mapping — RED → GREEN

**Likely files:** `server/domain/models/models-dev-import.ts`, `tests/runtime/models-dev-import.test.js`.

- RED: provider defaults lose to model overrides, unknown dialects auto-generate configs, env values leak, or family regex guesses succeed.
- GREEN: deterministic field-level merge; reviewed dialect allowlist; provider-specific key allowlist; explicit seven-family table; unknown states remain manual/unclassified.
- Refactor only after fixtures cover multiple env names and a model with a provider override.

## Task 3: Cache Isolation and Precedence — RED → GREEN

**Likely files:** `server/domain/models/models-dev-catalog-cache.ts`, `tests/runtime/models-dev-catalog-cache.test.js`.

- RED: catalog reads mutate `models.json`, cache outranks explicit user configuration, or a failed replacement destroys last-known-good data.
- GREEN: separate cache path/schema, atomic replacement, deterministic precedence (`models.json > explicit import > online cache > vendored snapshot`), and restart recovery.
- P2 refresh limits/ETag/online transport are specified here as extension points but are not required for P1 behavior.

## Task 4: Catalog Projection and Import API — RED → GREEN

**Likely files:** `server/api/model-providers-controller.ts`, `server/api/bootstrap-payload.ts` only if needed, `tests/http/model-providers-controller.test.js`.

- Add an explicit catalog read route and an explicit import action; keep existing provider CRUD route matching and masking behavior unchanged.
- The P1 route contract is `GET /api/model-catalog` (provider/model index), `GET /api/model-catalog?providerId=<id>&modelId=<id>` (single projection), and `POST /api/model-catalog/import` (explicit import). Query parameters are used because model IDs may contain `/`.
- The import body is restricted to `{ providerId, modelId, name?, baseUrl?, reasoning? }`; API keys, headers, env values, and arbitrary upstream fields are rejected.
- API responses contain normalized projection and provenance, never env values, raw credentials, or unsupported runtime controls.
- Import writes through `model-provider-persistence.ts` only after request validation and operator confirmation semantics are satisfied.

## Task 5: Provider Editor Import UI — RED → GREEN

**Likely files:** `public/personas/provider-editor.js`, `public/personas/provider-management.js`, `public/personas.html`, focused UI tests.

- Add “从目录导入” entry, provider/model search, manual/unclassified states, and explicit confirmation.
- Render catalog metadata separately from Pi runtime controls. Do not render `reasoning_options`, cost, limits, or modalities as editable runtime controls unless an existing CAFF capability explicitly supports them.
- Preserve existing secret masking, empty-on-read behavior, keyboard focus, and mobile layout.

## Task 6: Full Verification and Review

- Run focused runtime/API/UI tests first, then project check/typecheck/fast suite as documented by the repository.
- Use isolated acceptance data and Redis 6398 only; verify no secret value appears in response, logs, or cache.
- Execute `quality-gate → fresh-context-review → request-review`; request a different individual for domain and UI review.
- Do not mark AC-1 complete until the official snapshot provenance is independently verified.

## Acceptance Coverage Matrix

| AC | Test/evidence |
|---|---|
| AC-1 | Snapshot hash/source/license fixture |
| AC-2 | Provider/model override merge tests |
| AC-3 | Unknown dialect fail-closed tests |
| AC-4 | Multi-env names-only redaction tests |
| AC-5 | Cache isolation, precedence, atomic/last-known-good tests |
| AC-6 | Seven-family explicit map and unknown tests |
| AC-7 | Provider-editor metadata/control separation fixture |
| AC-8 | Existing model-provider controller/runtime regression suite |

## Commit Boundaries

1. `docs(F004): kickoff models.dev catalog and import`
2. `test(F004): add catalog schema and import contract fixtures`
3. `feat(F004): add models.dev normalization and isolated cache`
4. `feat(F004): add catalog projection and provider-editor import`
5. `test(F004): verify runtime, UI, and secret-safety gates`

Every implementation commit body must include a concise `Why:` statement and the cat identity footer. No self-review or self-merge.

## Open Questions

- Exact upstream snapshot commit/hash remains blocked by current official TLS failure.
- Final route naming must preserve the current controller's provider-id matching; implementation should choose the least ambiguous route after reading the controller tests.
- The initial seven-family and provider-specific env allowlists require review evidence before enabling new entries.
