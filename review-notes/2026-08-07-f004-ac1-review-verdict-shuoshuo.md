---
feature_ids: [F004]
topics: [review, verdict, models.dev, vendored, provenance, catalog, env-validation]
doc_kind: review-verdict
created: 2026-08-07
---

# Review Verdict: F004 AC-1 vendored models.dev snapshot

Review-Target-ID: `f004-ac1`
Branch: `feat/f004-ac1`
Reviewed HEAD: `1a5d568f791244b2075e0a3b28309b2f9abac286` (+ quality/review notes `96a9c35`)
Reviewer: 烁烁 (Siamese, cross-family vs author 砚砚/Maine Coon)

## Verdict: APPROVE

No blocking findings. All four review questions were independently re-verified rather than taken from the quality-gate report.

## Independent verification evidence

| Claim | My verification | Result |
|---|---|---|
| Upstream commit `e951706c7e89d932c0814bb53534b1762c2230ea` exists and matches declaration | GitHub API `commits/<sha>` | exists, timestamp `2026-08-07T08:31:14Z` == SOURCE.md; parent `8515b0748f…` matches the author's earlier retrieval-window read |
| Normalized providers hash reproducible | asset test recomputes `sha256(JSON.stringify(providers)+"\n")` and matches SOURCE.md | pass (1/1) |
| Raw payload hash `e9cf5169…` | fresh fetch of `https://models.dev/api.json` now yields `ff44694c…` | differs — consistent with dynamic upstream; raw hash is retrieval-window evidence, normalized hash is the post-hoc reproducible anchor (see note below) |
| MIT license artifact | `assets/model-catalog.LICENSE` starts with `MIT License` | present |
| Default controller loads vendored asset with no injected document | own in-process dogfood: empty agentDir, no `catalogDocument` | `{"handled":true,"statusCode":200,"providers":180,"firstProvider":"zhipuai","provenanceKind":"vendored"}` |
| Local-admin guard stays fail-closed | dogfood with mismatched authority | request rejected (guard, not catalog, blocks) |
| Build distributes the asset | `copy-build-assets.js` `copyDir(assets → build/assets)` + `build/assets/model-catalog.json` exists after build | verified |
| Env projection contains names only | scanned all 199 env entries across 180 providers | none contain `=` or value-like strings; the only numeric-leading name is `302ai:302AI_API_KEY`, matching the validator-fix story |
| Env-name regex boundary | reviewed `^[A-Za-z0-9_]+$` + regression tests | preserves numeric-leading upstream names; whitespace rejected by test; control chars excluded by construction (ASCII class, `+` quantifier rejects empty) |
| Full gate | own `npm run test:fast` | exit 0 |
| Focused suites | asset 1/1, import 6/6, cache 3/3, controller 6/6 | all pass |
| F004 doc delta | AC-1 status/hashes/commit match the verified facts; curl-path failure recorded honestly | accurate |

## Notes (non-blocking)

1. Raw payload SHA-256 is inherently non-reproducible once upstream moves (confirmed: today's fetch hashes differently). The durable anchors are the normalized providers hash (test-enforced) and the upstream commit SHA (independently confirmed). SOURCE.md already documents the hash semantics; a one-line hint that post-hoc verification should use the normalized hash would make this explicit for future renewals. Not a gate item.
2. Size stated as ~6.66 MB (decimal) vs 6.35 MiB on disk — consistent, just unit convention.

## OQ disposition

- OQ-1 validator boundary: correct as analyzed above.
- OQ-2 provenance sufficiency: sufficient — commit SHA independently verified upstream; normalized hash reproducible; license present.
- OQ-3 default controller path: verified, `models.json` untouched (read-only GET path exercised; import path unchanged from reviewed #57).

[烁烁/k3-256k🐾]
