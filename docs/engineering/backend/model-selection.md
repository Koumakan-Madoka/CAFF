# Explicit model selection (Issue #150)

## Configuration boundaries

- PI continues to own provider registration, model definitions and local resolution. A catalog entry is not a user's choice of execution model.
- CAFF no longer chooses `kimi-coding/k2p5` when configuration is absent. The exported `DEFAULT_PROVIDER` and `DEFAULT_MODEL` compatibility sentinels are empty. Nothing automatically selects the first catalog model.
- Digest entries, rollups, title refinement and failed/stopped-trace Recovery share the saved `recovery_scribe` provider/model/thinking fields from System Services. Model env settings and injected runners do not replace that selection. Recovery enablement and timeout remain separate from digest/title budgets.
- Roles, conversation execution and Skill Draft retain their supported explicit model settings and user-configured environment sources, without a vendor fallback. An invalid explicit selection never falls back to a different model.

## Local validation

`server/domain/models/model-configuration.ts` inspects the configured PI catalog. Only positive, matching `runtimeResolvable: true` evidence authorizes a selection; missing markers, explicit false, resolver exceptions and unsupported thinking fail closed. Registry resolution may validate an explicitly selected model without adding the whole registry to pickers. This does not test credentials or upstream availability.

- Recovery: GET/PUT/execution share the inspection. New blocked requests return `409 conversation_recovery_model_unconfigured` before new recovery/task/run/job records or model calls. Existing recovery records retain idempotency.
- Digest: missing selection in automatic/auto mode keeps the non-model extractive summary path. Explicit model mode or an invalid saved model returns `409 conversation_digest_model_unconfigured`; configuration errors do not enter the model-failure-to-extractive fallback. Unconfigured title refinement makes no model call.
- Skill Draft model mode: `409 skill_draft_model_unconfigured` before injected runners, PI invocation or draft persistence. Existing rule/manual generation is unchanged.
- Role/room participant validation: an editable custom role without a resolved default cannot authorize a room spawn. Runtime resolution rejects missing and unverified catalog choices before conversation execution tasks are created.
- Agent execution: the final model check precedes sandbox preparation, new messages, tasks and runs. Previously accepted user messages and existing parent tasks are not removed when a later configuration check blocks execution.
- Low-level `startRun`: empty provider/model is rejected with `model_configuration_required` before opening a run database or starting the SDK host. Callers cannot pass an empty selection through to PI's own implicit selection behavior.

Catalog invalidation after provider configuration saves makes the next inspection re-evaluate readiness. The shared service row is read for each model invocation; accepted in-flight work retains its model snapshot. Direct edits outside the configuration API are not a file-watching contract.

## Upgrade behavior

There is no automatic data migration, no implicit-default-to-explicit conversion, and no substitute-model selection. Existing explicit saved values are retained, including invalid values for diagnosis and repair. Unchanged disable-only Recovery saves remain available for broken or empty selections.

Deployments previously relying on the hardcoded vendor preference must explicitly choose their role/CLI/Skill Draft models. For summaries, title refinement and Recovery, save a model and thinking level in **System Services → System Scribe**, using models registered through **Model Providers**. Setting only `PI_PROVIDER`/`PI_MODEL` or `CAFF_DIGEST_*` no longer configures the shared scribe.

CLI usage with a prompt now requires explicit `--provider` and `--model` (or user-set `PI_PROVIDER`/`PI_MODEL`). Empty configuration is a setup state, not a claim that a provider is unavailable remotely. No production configuration is rewritten by this change.
