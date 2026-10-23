# External Planner Interface (P1)

## Scope and delivery status

This is the P1 contract for [ADR 0002](../../decisions/0002-external-planner-drives-caff.md).
It covers planner attribution, mutation guards, Goal control, durable attention,
and bounded monitoring. It does not introduce a CLI, MCP, a review/verdict
protocol, different implementer prompts, or new DAG/delegation/Feishu behavior.

**M1 planner-reviewed contract; implementation in progress, not shipped.**
M1 passed planner re-review at `6d22d583`; the required credential-location
amendment was committed at `1a0fdb74`. M2–M5 must implement and verify this
contract before integration into `develop`.

Related implemented contracts: [Session Goal](session-goal.md),
[DAG execution, D28](dag-execution.md), [controller patterns](controller-patterns.md),
[conversation titles](conversation-title.md),
[session reuse](../runtime/agent-session-reuse.md), and
[ADR 0001](../../decisions/0001-goal-driven-workflow.md).

## 1. Principals and credential

### Principal model

The server derives the principal before invoking a mutation. JSON fields such
as `ruledBy`, `senderName`, `source`, `kind`, or a claimed name cannot authenticate
or override it.

```ts
type Principal =
  | { kind: 'user' }
  | { kind: 'planner'; plannerId: string; plannerName: string }
  | { kind: 'agent'; agentId: string; agentName: string }
  | { kind: 'system' }; // internal/legacy, never a user-only gate bypass
```

P1 supports one configured local planner identity per server instance:
`plannerId = 'local-planner'`, `plannerName = 'External Planner'` by default.
The deployment may configure the name (`CAFF_PLANNER_NAME`); requests cannot.
M2 must document this optional setting in `.env.example`, including the default
and an example `# CAFF_PLANNER_NAME=Claude Code`. This configures attribution,
not a credential or a Room agent. M1 changes only this interface contract; it
neither edits the local environment nor implements the setting.
The ID is stable across credential rotation. A planner is not a Room participant,
cannot own a Goal, and consumes no model slot. Multiple independent planner
identities and credential administration are not P1 features.

### Credential file (planner-confirmed approach; Windows protection amended)

- Generate 32 cryptographically random bytes, base64url-encoded, on each server
  start. Compare the supplied value without timing-dependent string comparison.
- Write `{ version: 1, plannerId, plannerName, token, issuedAt }` atomically in
  the current user's state directory, **not agentDir**. Repository/agentDir
  ancestors may allow sandbox accounts or other accounts to modify/replace the
  path; a protected file DACL alone cannot make that location trustworthy.
  Defaults: Windows `%LOCALAPPDATA%/CAFF/planner/`; POSIX
  `${XDG_STATE_HOME:-~/.local/state}/caff/planner/`.
- The deterministic filename is `planner-<hostHash>-<port>.json`, where hostHash
  is the full lowercase hex SHA-256 of the UTF-8 configured bind host after
  trimming, lowercasing and removing surrounding IPv6 brackets; port is the
  actual bound decimal port (resolve port `0` after listening). Clients compute
  it from the instance's bind host/port, not a request Host alias. Distinct
  instances use distinct files; rotate only after successfully binding.
- `CAFF_PLANNER_CREDENTIAL_FILE` overrides the entire filename; require an
  absolute path and apply the same protection/ancestor checks. Missing required
  state-directory configuration or unsafe paths fail closed. Log the resolved
  credential path at startup, never the token. This is runtime state, never a
  repository file. M2 documents both planner settings in `.env.example`.
- The directory/file must be owner-only: directory `0700` and file `0600` on
  POSIX; the SID-only, protected Windows DACL specified below on Windows.
  A chmod call alone is not evidence of Windows confidentiality. Reject
  symlink/reparse-point destinations and unsafe existing permissions. Secure
  the runtime directory and an empty temporary file **before** writing any
  token bytes; re-verify the final file after atomic replacement.
- Verify permissions before publishing the credential. If secure creation or
  verification fails, disable planner authentication and log a non-secret
  diagnostic; the browser console remains usable. Never publish an insecure
  token or fall back to treating a planner as the user.
- Isolated instances must have different agent directories, databases and
  credential files. Automated server tests inject an in-memory credential by
  application options (not an environment-controlled production bypass), on
  Windows and Linux alike. Storage-specific POSIX tests use private temporary
  state. Tests never read or rotate real service credentials. The user-approved
  Windows ACL test exception (2026-10-23) uses a new, exclusive random directory
  under `%LOCALAPPDATA%/CAFF/planner-tests/`, deletes it afterwards, and never
  changes ACLs on shared ancestors. Other test state/logs remain in system Temp;
  Temp itself is not a safe Windows credential ancestor on this machine.
  The DACL denies ordinary other local accounts, including
  accounts whose access comes from CodexSandboxUsers or unresolved group SIDs.
  Processes under the **same account** can still read the credential. SYSTEM
  and administrators exercising ownership/privilege are not isolated by this
  scheme. This is attribution/gating, **not** a same-account OS sandbox boundary.
- Rotation invalidates the previous token. A client receiving 401 may re-read
  its locally configured file; it must not retry as a browser/user principal.
  No token in bootstrap, URLs, messages, SQLite records, errors, logs or SSE.

#### Windows setting and language-independent verification

Node has no built-in ACL API. Use the OS Windows PowerShell executable at the
trusted system path (`%SystemRoot%/System32/WindowsPowerShell/v1.0/powershell.exe`)
to call .NET `System.Security.AccessControl` APIs. Invoke it with an argument
array, `shell: false`, `-NoLogo -NoProfile -NonInteractive -EncodedCommand` and a
fixed UTF-16LE/base64 script. Set stdin/stdout encoding explicitly to UTF-8;
send paths as JSON on stdin, never interpolate a path into code. The ACL helper
never receives token bytes. Do not resolve PowerShell from PATH, load profiles,
parse `icacls`/`whoami` display text, or use localized account names. Missing/blocked PowerShell is a secure-creation failure,
not a reason to weaken the permissions.

1. Obtain the current process account SID from
   `[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value`.
   Set the owner with `SecurityIdentifier`, not `NTAccount`. The allowed SID set
   is exactly that account plus optional SYSTEM (`S-1-5-18`); no Administrators,
   Users, Everyone, CodexSandboxUsers, or unresolved additional SID is allowed.
2. Construct a **new** `DirectorySecurity` / `FileSecurity`, set the owner, and
   call `SetAccessRuleProtection(true, false)` (protect DACL, discard inheritance).
   Add explicit `Allow` / `FullControl` rules only for the allowed SIDs.
   Directory rules use `ContainerInherit | ObjectInherit` and propagation None;
   file rules use inheritance None and propagation None. Replace the entire
   DACL using `Directory.SetAccessControl` / `File.SetAccessControl`, or pass the
   new security descriptor to their creation-time .NET overloads (directory
   creation / `FileStream` with `CreateNew`) so access is private from creation.
   Do not just add grants, retain old explicit ACEs, truncate an existing
   temporary path, or modify unrelated parent/repository ACLs. Apply this to
   newly created runtime directories and the empty temporary file. Existing
   unsafe private directories are rejected, not silently repaired. Validate
   any existing destination before rotation;
   unsafe ownership/permissions fail closed, rather than trusting or reading its
   contents. Never expose a nonempty broadly readable temporary file.
3. Re-read owner, DACL and file attributes from the filesystem, not from the
   object used to set them. Use `GetOwner(typeof(SecurityIdentifier))` and
   `GetAccessRules(true, true, typeof(SecurityIdentifier))`; emit machine JSON
   with SID strings, numeric rights/type/inheritance/propagation flags,
   `IsInherited`, `AreAccessRulesProtected` and reparse attributes. Do not use
   translated identity or rights text. A pure validator checks: owner equals
   current SID; protected, non-null/nonempty DACL; exactly one expected explicit
   Allow/FullControl ACE per allowed SID; expected flags for directory/file;
   no inherited, deny, unknown-SID or unsupported ACE. Reject malformed/truncated
   JSON and an unreadable or unsupported security descriptor. An unknown SID
   is not ignored merely because Windows cannot resolve its account name.
4. Only enable planner authentication after directory and final file pass this
   verification. On helper/set/read/validation failure, remain disabled, do not
   publish or use the new token, and reject planner intent with 401. Log a
   structured non-secret diagnostic: `planner_credentials_disabled`, stage
   (`create`, `set_acl`, `verify_acl` or `publish`), target path, expected/actual
   owner SID, DACL protection flag, offending ACE SID and numeric rights/flags,
   stable failure reason, and helper exit code or numeric OS error when present.
   Never log credential content, stdin containing credentials, or unfiltered
   subprocess output; the browser remains available.

Path integrity is also required: a DACL on a file does not prevent an untrusted
account from replacing an ancestor it controls. Detect unsafe writable/reparse
ancestors and fail closed rather than repairing shared repository/sandbox ACLs.
Apply these checks to the user-state location or explicit override, not the
old agentDir location. Use a trusted per-instance state location when they fail;
never silently fall back to the repository. Ancestor checks may trust the
current account, SYSTEM, administrators and Windows' privileged TrustedInstaller
service SID (POSIX root); this does not permit those extra SIDs in the private
credential directory/file DACL. Checks must distinguish
ordinary read/traverse access from rights permitting path replacement. A
root-owned POSIX sticky temporary ancestor is compatible with a securely owned
private child; an arbitrary other-user-writable ancestor is not.

M2 evidence must include automated command-construction and pure ACE-validation
tests: paths with spaces/quotes/Chinese characters, SID-only grants, stale
explicit or inherited group grants (including unresolved SIDs), missing owner
access, unprotected/null DACL, wrong owner/flags, helper failure and malformed
output. Separately, before M2 review, GPT or the planner must run a **local
Windows check** against an isolated instance: inspect the actual directory and
file descriptors by SID, resolve the local CodexSandboxUsers SID for the check
only, confirm that group has no read access, and prove a credential-authenticated
request succeeds. Record the check method, sanitized SID/ACE result and HTTP
status, never the token. If a sandbox-account access probe is available, attempt
a read and record access denied without printing file contents. A missing local
check is missing M2 evidence; mock tests alone do not establish Windows secrecy.

### Planner intent and authentication

Planner clients send `Authorization: Bearer <token>`. On ordinary API routes,
`X-CAFF-Principal: planner` explicitly declares planner intent even if the
Authorization header was accidentally omitted. All `/api/planner/*` paths
implicitly declare planner intent. Any Authorization header on an ordinary
browser API route also declares intent; unsupported schemes, duplicate or
malformed headers, empty/wrong tokens and missing credentials for declared
intent return **401 `planner_credential_invalid`**, with no writes or scheduling.
A valid browser CSRF token does not rescue a failed planner claim.

A request with no planner indication follows the browser guards; it is not an
unauthenticated REST backdoor. Clients must not omit both indications on retry.
Planner-only reads require the credential too. GET/HEAD alone do not grant a
planner identity. CORS does not allow third-party origins or bearer access.

Agent callbacks and the exact Feishu webhook route are separate trust domains:
they always use their existing authentication, never acquire user/planner
powers through this exemption, and cannot use a bearer to replace callback or
webhook validation. `X-CAFF-Principal: planner` on those routes is rejected with
401; their native headers are not reinterpreted as planner credentials.

### Attribution and authority

- Planner messages retain transport `role: 'user'` for routing compatibility,
  but persist `senderName: plannerName`, `metadata.source: 'planner'` and
  `metadata.principal: { kind: 'planner', plannerId, plannerName }` server-side.
  They are displayed as the planner, not You / web-ui. This preserves the
  existing message role vocabulary without equating role with authority.
- Browser messages remain You / web-ui. Agent callbacks retain their invocation
  identity. No client-submitted principal is trusted.
- Planner proposal rulings persist `ruledBy.kind = 'planner'`, ID and name in
  the durable ruling and cleared-event payload. User rulings remain `user`.
- Only `kind === 'user'` may waive a high-risk criterion or change/remove a
  committed decision linked by `adrPath`. All other kinds return 403, including
  planner REST direct actions, proposal acceptance, and replacement paths that
  would otherwise bypass the same check. Failure leaves all state unchanged.
  M2 review R2: non-user principals (including planners and agents) also cannot
  downgrade an existing high-risk criterion to any non-high risk, delete its ID,
  or omit it when replacing/clearing a Goal. Check against the previous Goal,
  regardless of the criterion's current acceptance status while that Goal is
  unfinished. M3 review N8: when the previous Goal is already `complete`,
  retiring that Goal with replacement `set` or `clear` is exempt from this
  downgrade/removal check, for direct actions and accepted proposals alike.
  This does not exempt `revise`, waive any new high-risk criterion, or bypass
  the accepted-ADR decision gate. Creating/replacing/clearing a Goal still
  requires the explicit user approval/attestation specified by ADR 0002.
  Return 403 `goal_high_risk_change_user_required`; a high-risk waiver still uses
  `goal_high_risk_waiver_user_required`. This prevents downgrade-then-waive and
  delete/replace bypasses. Users may make these structural changes subject to
  ordinary validation; normal-risk changes/deletions remain unchanged. Agents
  may propose changes for a user to rule on, but cannot accept them themselves.
- Normal waivers still require reviewed `revise`, evidence/reason validation,
  and independent review. `update-delivery` cannot introduce a waiver.
- Generic Room `PUT` is not a Goal write backdoor. When replacing unrelated
  metadata, preserve server-owned `sessionGoal*` keys (Goal, proposal, ruling,
  runner and future audit/binding state) and the existing D28
  `dagNodeGoalBinding` enforcement anchor. Explicit changes to those keys return
  403 `goal_metadata_reserved` for both browser and planner; an unchanged
  snapshot may be echoed. Use the Goal endpoint for all Goal mutations.
- ADR 0002's other reserved approvals remain planner-attested, not an invented
  server-verifiable delegation policy. The planner records where and when the
  user approved in the Goal action/ruling `reason`, or in a preceding attributed
  public planner message for operations without a reason field. Such a claim
  never satisfies either of the two server-enforced user gates.

## 2. Write-interface hardening

Apply guards centrally **before body parsing, persistence, dispatch or external
side effects** to every `/api/*` method except GET, HEAD and OPTIONS. A POST
whose action happens to be `get` is still a write request. OPTIONS is not a
write capability and does not receive permissive CORS headers.

| Caller / route | Required validation |
| --- | --- |
| Browser, ordinary API write | Valid configured Host authority (loopback aliases below), same-origin Origin, JSON Content-Type, CSRF header |
| Browser `POST /api/conversations/:id/images` | Same Host, Origin and CSRF; `multipart/form-data` with valid boundary instead of JSON |
| Authenticated planner, ordinary API write | Host and the route's Content-Type; bearer replaces Origin and CSRF, not other validation |
| `/api/agent-tools/*` | Existing invocationId + callbackToken and invocation-scope checks; no browser CSRF/Origin or new Host requirement |
| `POST /api/integrations/feishu/webhook` | Existing webhook verification/challenge handling; no browser CSRF/Origin or new Host requirement |

Host means the configured listening authority, with the actual bound port
(including a port allocated from `0`), not an authority reconstructed from the
untrusted Host header. Do not trust forwarded headers or resolve arbitrary
hostnames to decide trust.

- For a loopback bind, the allowed authorities are `127.0.0.1:<port>`,
  `localhost:<port>` and `[::1]:<port>`. Host accepts any of these, and browser
  Origin must be the same HTTP origin as the **validated request Host**,
  including port. Thus opening the UI at localhost works with a 127.0.0.1 bind;
  a cross-alias Origin/Host pair is still cross-origin and rejected. Only these
  literal aliases qualify; an attacker-controlled DNS name resolving to
  loopback is not an alias.
- For a non-loopback bind, Host must exactly match the configured authority,
  and Origin must equal its HTTP origin; there is no loopback-alias exception.
- Missing, `null`, different-origin or different-scheme browser Origin is
  rejected. Existing local-only admin routes retain their additional loopback
  bind/peer checks, including for planners; their write guards use the same
  alias rules. General Room routes gain no loopback-only restriction.

**Read-side scope / known limitation:** P1 adds no Host checks to read routes.
Ordinary reads that currently lack Host validation continue to lack it; the
existing local-admin read restrictions are not removed. DNS rebinding that
reads data through those ordinary routes remains a known risk, deferred to a
separate change. Planner-only reads still require their bearer credential.
Do not treat this mutation-hardening work as read-side DNS-rebinding protection.

JSON means `application/json`, optionally with parameters such as charset.
Even bodyless DELETE/POST clients send this Content-Type (`{}` when needed).
Only the exact image-upload route has the multipart exception; keep all image
size/count/MIME/dimension checks. Other form/text Content-Types return 415.

CSRF uses `X-CAFF-CSRF-Token`. Expose the per-process random CSRF token through
same-origin bootstrap as `apiSecurity: { csrfToken }`, never the planner token.
Preserve existing `localAdmin.*.csrfToken` bootstrap aliases during migration.
Shared `fetchJson` and `fetchFormDataJson`, plus any direct mutation fetches,
attach it. Fetch a token before the first write on every page (chat, personas,
projects, skills, metrics/admin). Do not set multipart Content-Type manually.
A stale token after restart requires bootstrap refresh; do not automatically
replay a possibly committed non-idempotent write.

## 3. HTTP surface and retry contract

All JSON responses use UTF-8, `Cache-Control: no-store`, and the existing error
shape `{ error: string, code?: string, issues?: Array<object> }`. Errors contain
no request credentials. Existing browser response envelopes remain compatible.
IDs below are server-issued, not names to be resolved heuristically.

| Method / path | Request and successful response |
| --- | --- |
| `POST /api/conversations` | Existing `{ title?, projectScopeId, modeId, participants }`; 201. A nonblank explicit title is manual at creation. Planner response is `{ conversationId, title, titleSource, projectScopeId, modeId }`, no Room directory/messages. |
| `POST /api/conversations/:id/messages` | `{ content, imageIds?, clientRequestId? }`; 200 `{ conversationId, acceptedMessage: { id, senderName, role, metadata }, dispatch, dispatchLane, dispatchTargetAgentId }` for planners; no message/history echo. Existing routing and quick acknowledgement stay unchanged. |
| `GET /api/conversations/:id/goal` | Existing complete normalized Goal/proposal/ruling projection; use when the full delivery contract or proposal snapshot is needed. Keep the browser envelope; do not hydrate message bodies for this route. |
| `POST /api/conversations/:id/goal` | Action object described below; planner 200 `{ conversationId, goal, proposal, ruling, cleared, autoContinuation }` without conversation/messages/directory. These are complete contract records, unlike the monitoring summaries. Browser keeps its existing envelope. |
| `GET /api/planner/conversations/:id/state` | Credential required; bounded `GoalState` in §7. 404 for missing Room; null Goal permitted. |
| `GET /api/planner/portfolio` | Credential required; `{ items: PortfolioItem[], observedAt }`, all Rooms with a Goal or pending set proposal. |
| `GET /api/planner/attention` | Credential required; cursor page in §6. |
| `GET /api/planner/attention/wait` | Credential required; same page, after arrival or timeout. |
| `POST /api/planner/attention/:sequence/resolve` | Credential required; `{ reason }`; 200 `{ item }`. Only explicit acknowledgements allowed by §5; never hides a still-active blocking condition. |

Other routes retain their current endpoints and domain validation. Authentication
is not authorization to push, bind workspaces, add agents, restart or delete
without the user's approval. There is no planner-specific execution bypass.

### Goal concurrency

For every authenticated planner Goal write:

- Supply `goalId` and `goalRevision` from the last complete read. All actions,
  including lifecycle, owner change, replacement, clearing and rulings, check
  them before mutation. When there is no live Goal, first `set` and rulings on
  a pending proposal use `goalId: null, goalRevision: 0` to mean “no current
  Goal”; this includes accept-proposal, dismiss-proposal and operations with
  literal supersedeProposal=true. Such operations involving a pending proposal
  must also supply its exactly matching proposalId. Missing proposalId is still
  rejected, and revision zero is never valid when a live Goal exists.
- Missing/invalid preconditions return 400 `goal_revision_required`; a different
  Goal ID or revision returns 409 `goal_revision_conflict`. Read again and
  inspect the change before deciding on a new action; never blindly force a
  stale write.
- Rulings and confirmed supersession additionally require `proposalId`, exactly
  matching the pending proposal, or 409 `goal_proposal_conflict` (including a
  missing ID). This protects proposals created or
  replaced without a Goal revision change. No pending proposal returns 404.
- Browser and agent compatibility remains: existing required revision checks
  for revise/update-delivery and proposal baseRevision are retained. They may
  supply the stronger preconditions too; they are not newly required on old
  lifecycle callers. The UI sends proposalId when confirming a supersession.

### Idempotency

Use each operation's existing safety mechanism, not a universal receipt table:

- **Planner Room creation only** requires `Idempotency-Key` (nonblank opaque
  string, at most 200 characters); missing/invalid returns 400
  `idempotency_key_required`. Persist a Room-creation-specific mapping scoped
  by planner ID and key, with a semantic request digest and created Room ID,
  atomically with the Room. Same key/payload returns the original 201 lean
  creation result with `Idempotency-Replayed: true`, not another Room. A
  different payload returns 409 `idempotency_key_conflict`. Concurrent requests
  serialize; mappings survive restart/rotation. Keep a non-reusable key
  tombstone when the Room is deleted, until separately authorized cleanup;
  retry then returns 410 `conversation_gone`, never recreates the target.
  Never store credentials.
- **Goal writes** require no Idempotency-Key or receipt. The goalId/revision
  preconditions (plus proposalId for rulings/supersession) prevent replay of a
  committed action. After a lost response, repeating the old request gets 409
  (or 404 if its Goal/proposal was cleared); re-read and inspect state rather
  than expecting the old result or automatically submitting at a new revision.
- **Messages** require no Idempotency-Key. Planner clients must provide and
  reuse `clientRequestId` when retry safety is needed. Keep the existing
  persistent per-Room message deduplication and `MESSAGE_IDEMPOTENCY_CONFLICT`
  for changed content/imageIds. A duplicate must not cause another dispatch;
  this does not require storing a full HTTP response receipt.
- **Attention resolve** requires no key or receipt: it is a monotonic
  unresolved-to-resolved transition. Retrying returns the existing resolved
  item, never another resolution or overwrite of the original reason/principal.
- Other mutation routes keep their existing journals, preconditions and retry
  rules. No general retry-safety claim is made for operations without such a
  mechanism: a supplied Idempotency-Key does not make an arbitrary write safe.

A crash after commit but before dispatch/broadcast must not lose accepted work:
use the existing durable message queue and runner recovery. Publishing SSE and
waking waiters happen after commit. Do not claim exactly-once model execution;
the existing execution/reconciliation contract remains authoritative.

## 4. Goal actions, ownership and binding

Goal fields, evidence validation, completion requirements and IDs are those in
`session-goal.md`, with the following changes.

| Action | Inputs / semantics |
| --- | --- |
| `set` | Required objective and nonempty acceptanceCriteria; optional decisions/workItems/evidence. Optional `owner: { agentId }` and `status: 'active' \| 'paused'` (default active). Creates a new goalId at revision 1. |
| `revise` | Partial structural delivery contract, merged as below; reason/impact remain required when changing provisional decisions. Does not replace the Goal ID or owner. |
| `update-delivery` | Partial factual delivery state; merges omissions, preserves pending proposal/ruling and same-Goal runner counters. Structural definitions and new waivers remain forbidden. |
| `set-owner` | Existing `ownerAgentId`, plus reason for planner reassignment; current routable participant/runtime profile required. Planner reassignment records an owner_changed entry (previous/new owner and reason, authenticated reviewer) in bounded Goal changeNotices. Does not reset runner budget/failure counters or discard proposal/ruling. Only the legacy user/internal path may clear owner. |
| `bind-planner` | User-only explicit adoption of the configured planner for an existing unbound, non-DAG Goal; required goalId, goalRevision and reason. Preserves Goal identity/content, owner, status, evidence and runner counters; details below. |
| `pause`, `resume`, `complete` | Existing lifecycle behavior, now guarded against proposal loss. Completion still needs all criteria passed or validly waived. Resume starts the existing fresh runner cycle; P1 does not change budgets. |
| `accept-proposal`, `dismiss-proposal` | Rule on the identified pending proposal with reason and server-derived principal; accepted proposal baseRevision must still match. |
| `clear` | Destructive, explicit user approval required by ADR 0002; preserve audit before clearing the live Goal/binding/proposal. |

Server resolves owner names from the current routable Room roster. An unknown,
removed, retired/unavailable or platform-only system actor returns 400
`goal_owner_invalid`; a supplied name cannot make an ID routable. An omitted
owner on legacy direct `set` preserves default routing; accepting an agent's
set proposal still defaults to its proposer. A supplied owner overrides that
default after validation. A paused initial Goal must enqueue **zero** continuation
messages. An active Goal's first continuation must target the persisted owner,
not participant order. `status` is initial set state, not a revise/update shortcut.
A pending set proposal stores this separately as `initialStatus` (its own
`status` stays `pending`) and retains an explicit proposed owner. Acceptance
revalidates that owner against the current roster and selected runtime profile;
an owner removed or made unavailable since proposal creation returns 400 without
consuming the proposal. A supplied name is never authoritative. Internal
application/automatic creation titles keep their existing title-source behavior;
only a caller-supplied nonblank title at the Room-creation HTTP boundary is manual.

### Merge semantics

Merge **before** normalization and validation, for REST direct revise, agent
revise proposals and factual updates alike:

- Absent objective, decisions, acceptanceCriteria, workItems and evidence keep
  their exact previous values. Absent decision groups keep their old arrays.
- An explicitly supplied array replaces that collection, not an append/union.
  `[]` clears it, subject to existing validation (for example a revised Goal
  still needs at least one criterion; referenced evidence cannot disappear).
- For a supplied criterion/work item/evidence record with a known ID, omitted
  properties retain their old values, including status, risk, timestamps,
  evidenceRefs, waiver and criterionIds. New records use existing defaults.
  A supplied collection must list **every ID to retain**; an unchanged retained
  item can be just `{ "id": "existing-id" }`. Removing an ID removes that record,
  subject to validation; removing a criterion/work item is structural, so
  update-delivery returns 409 rather than accepting such a deletion. Evidence
  replacement remains factual if all proof-link rules pass. List omission
  preserves the entire collection.
- Changing a criterion's definition cannot inherit a passing result for the old
  definition. Preserve existing UI replacement-ID/proof-link safety. Changed
  definitions require explicit valid new acceptance state, never silent proof
  transfer: an existing criterion whose statement, verifyBy or risk changes must
  supply status; passed additionally supplies evidenceRefs, waived supplies waiver.
  Otherwise return 400 `goal_acceptance_state_required`. Proof-link and user-only
  validations still apply. Factual updates that change definitions return 409.
- `null`, wrong collection/property types and blank required text return 400
  `goal_patch_invalid`; they are not implicit clear commands. `decisions: {}`
  preserves every group. Legacy acceptance_criteria/verify_by and checklist
  aliases still work when the canonical field is absent; canonical wins if both
  are supplied. Merge aliases before normalization too.
- An old client sending the entire current Goal keeps replacement semantics for
  its explicitly supplied collections. A fully supplied, valid old payload has
  the same normalized result as before, apart from the documented corrections.

Example factual write: the existing Goal has work items `w1`, `w2`, criteria
`c1`, `c2`, and evidence `e0`; `e1` is new. Unchanged retained records list only
their IDs. Other fields remain equivalent in the normalized Goal, apart from
normal revision/update timestamps:

```json
{
  "action": "update-delivery",
  "goalId": "goal_example",
  "goalRevision": 7,
  "workItems": [{ "id": "w1", "status": "done" }, { "id": "w2" }],
  "acceptanceCriteria": [
    { "id": "c1", "status": "passed", "evidenceRefs": ["e1"] },
    { "id": "c2" }
  ],
  "evidence": [
    { "id": "e0" },
    { "id": "e1", "criterionIds": ["c1"], "kind": "test", "summary": "Targeted regression passed" }
  ]
}
```

Here the supplied arrays replace their collections: callers must include every
item they wish to retain in those arrays. A client changing just evidence can
omit workItems and acceptanceCriteria entirely.

### Proposal-loss guard and ruling history

`set`, `revise`, `pause`, `resume` and `complete` with a pending proposal return
409 `goal_proposal_pending` with no changes. Only literal
`supersedeProposal: true` authorizes discarding it. Planners must also send the
current proposalId; UI confirmation does too. A mismatched supplied ID returns
409 rather than discarding a newly arrived proposal.

Successful supersession atomically records a ruling with a server-issued ID,
`outcome: 'superseded'`, original proposalId/action/full snapshot, principal,
reason, time, old goalId/revision and superseding action, then performs the
requested action and resolves the proposal's attention item. The ordinary
`sessionGoalRuling` remains the latest ruling projection; append-only SQLite
ruling history retains all previous accepted/rejected/superseded rulings across
lifecycle mutations and Goal replacement/clear. Do not grow unbounded Room
metadata or erase the last ruling on pause/resume/revise. Replacement set may
clear the old epoch's live ruling projection (required by DAG child redispatch),
but not its archived record; accepted set or superseding set installs its new
ruling. A rejected or failed superseding operation must not create a superseded ruling. Explicit clear also
archives any pending proposal as superseded before clearing live metadata.
Deleting a Room may delete its history as part of that separately approved
operation; there is no background history pruning in P1. The SQLite archive
is `chat_goal_rulings`, separate from metadata, with immutable ruling IDs and
append order. When the latest ruling projection changes, archive the previous
snapshot and the new ruling in the same metadata transaction; an unchanged
projection is not re-appended on unrelated Room updates. Clear can additionally
archive its final ruling without retaining live Goal metadata. New or explicitly
changed ruling records remain strict: reusing an archived ID for different
content fails and rolls back the entire write.

M3 review N9: an already-present historical snapshot whose ID conflicts with an
archived record must not freeze Room updates or startup. While archiving the
**previous snapshot** or backfilling legacy metadata, keep the immutable archived
record and skip that conflicting legacy snapshot with a sanitized
`goal_ruling_legacy_conflict` diagnostic (stage and Room ID, no ruling content).
An unchanged old-format/malformed/conflicting projection does not block title,
participant or unrelated metadata updates. Do not swallow SQLite/write failures
or relax validation for a newly submitted ruling. Startup idempotently archives
recognized legacy rulings in metadata-only batches, preserving absent/legacy
attribution rather than inventing a user principal.

Agent `suggest-goal` retains its existing technical replacement behavior:
submitting another proposal may replace a pending proposal without new CLI
parameters or a Goal revision bump. In that **same transaction**, append a
superseded record containing the old proposal ID/action/full snapshot, the
replacing agent's identity and `supersedingProposalId` (the new proposal ID),
then persist the new proposal. The old proposal's attention item becomes
resolved as superseded and the new proposal gets its own attention item.
The complete replay feed therefore retains both sides of the replacement,
including replacements by a different proposer. This is audit of draft
replacement, not an accepted/rejected verdict or permission for an agent to
rule on a planner-bound Goal. M3 implements the ruling/proposal transaction;
M4 adds both attention transitions to that same transaction.

The browser displays the pending proposal before sending a conflicting action;
a 409 caused by a race also offers confirmation. Only an explicit user confirm
retries with supersedeProposal and the displayed proposalId; cancellation has
zero writes. Normal agents still propose lifecycle/structural changes rather
than acquiring direct mutation powers.

### Planner-driven binding

A planner direct `set` or planner acceptance of an agent's `set` writes
`metadata.sessionGoalPlannerBinding = { goalId, plannerId, plannerName, boundAt }`
in the same transaction. A user may explicitly request `plannerDriven: true`
when setting/accepting a set, binding the configured local planner. Existing
unbound Goals are not silently rebound merely by a planner read or factual write.

To adopt an existing Goal without replacement, the browser/user may submit
`{ action: 'bind-planner', goalId, goalRevision, reason }`. This action requires
`kind === 'user'`; planner and agent callers return 403
`goal_planner_binding_user_required`. Check the supplied ID/revision even for
user callers; missing/stale preconditions use the concurrency errors in §3.
An existing binding returns 409 `goal_planner_binding_conflict`; a pending
proposal returns 409 `goal_proposal_pending` (rule first; this action has no
supersede shortcut). Native DAG bindings remain ineligible. Atomically add the
configured planner binding, increment Goal revision/update time, and retain
all delivery content, owner, lifecycle status, latest ruling and runner
budget/failure counters. Do not create a new Goal or reset/enqueue a runner
cycle merely to bind it. The revision follows the existing fresh-session rule.
Record `adoption: { boundBy: { kind: 'user' }, reason }` in the binding, with
`boundAt` as the time; this is not a proposal ruling. No implicit adoption or
binding is permitted. In M3 the Goal panel adds a minimal “交给规划者” entry for
an eligible unbound Goal. It displays a user confirmation, then sends bind-planner
with the displayed ID/revision and reason through the CSRF-protected browser
path (user principal, never planner bearer); cancellation has no writes.
Refresh on a concurrent-change 409 rather than silently rebinding a changed Goal.

The binding is scoped to that Goal ID, survives credential rotation, lifecycle,
owner changes and restarts, and is removed on clear or a user replacement set
unless explicitly reselected. A malformed binding fails closed for agent
rulings rather than normalizing to unbound. Both accept and reject by **any**
in-room agent return 403 `goal_planner_ruling_required`, before mutation, even
when the agent is not the proposer. The matching planner and the user may rule;
self-review checks remain for agent paths on unbound Goals.

DAG node bindings take precedence: planner binding cannot be added to a DAG
child, and a planner is not the DAG verifier or a user manual-verification path.
A planner attempt to rule on a bound DAG node returns 403
`dag_verifier_only`; native worker/verifier, exempt-node scheduler and user paths
are unchanged. A conflicting planner/DAG binding fails closed. Do not broaden
D28's `kind === 'user'` check to include planner.

## 5. Durable attention lifecycle

SQLite stores attention separately from Room metadata. Each item has:

```ts
{
  sequence: number;              // positive global monotonic SQLite sequence
  conversationId: string;
  goalId: string | null;        // null when no live Goal exists at occurrence
  goalRevision: number;          // occurrence revision (0 without a Goal), not a mutable cursor
  kind: 'proposal_pending' | 'budget_exhausted' | 'failure_paused'
      | 'owner_removed' | 'goal_completed' | 'turn_failed';
  sourceId: string;              // proposal, runner-cycle, owner incident or turn ID
  summary: string;               // sanitized, at most 500 Unicode code points
  createdAt: string;
  resolvedAt: string | null;
  resolution: string | null;     // e.g. proposal_accepted, goal_resumed, acknowledged
  resolvedBy?: Principal;        // automatic resolutions use system
}
```

M4 planner clarification: an initial pending set proposal may exist before any
live Goal. Its attention row has required conversationId, goalId=null and
goalRevision=0, deduplicated by proposalId as usual. Acceptance, dismissal and
supersession update only resolution fields; they never backfill or rewrite the
occurrence's Goal identity. Read the new Goal from the state view. Portfolio
includes these Rooms with state.goal=null as specified in §7. A failed turn
without an associated live Goal does not create a turn_failed item.

Unique occurrence keys prevent duplicate items during retry, event re-entry and
restart reconciliation. Sequence allocation never reuses a committed sequence
within the same database; restoring a different/older database requires client
cursor reset. Source identity is not a raw timestamp or arbitrary error text. Non-proposal
conditions use server-issued incident IDs, retained in a small SQLite current-
condition mapping in the same transaction as their attention rows. The mapping
survives restart and acknowledgement; ending a condition removes its mapping,
not its replay history. A later recurrence receives a new incident ID. For
budget exhaustion, the existing effective runner's persisted allocation counter
(`iteration >= maxIterations > 0`) establishes exhaustion independently of
proposal presence; this is notification only, not a change to claim/dispatch
rules or an extra runner iteration.

| Source | Creation / deduplication | Resolution |
| --- | --- | --- |
| New pending proposal | Once per proposalId, including system pause/resume proposals | Accepted, rejected or durably superseded |
| Runner budget reached | Once per Goal + existing runner cycle, **even if another proposal is already pending** | Explicit resume/new cycle, Goal completed/replaced/cleared |
| Failure circuit-breaker pause | Once per error-paused runner incident | Explicit resume, or Goal completed/replaced/cleared |
| Owner removed/unroutable | Once per removed-owner incident, eager roster path and lazy runner path share key | Valid owner assigned/restored, or Goal completed/replaced/cleared |
| Goal complete | Once per Goal's transition to complete (including accepted complete proposal) | Planner acknowledgement or replacement/clear; mere reads do not resolve it |
| Terminal turn failure | Once per final failed turn ID associated with a Goal | A later successful terminal transition for the same Goal/agent/lane, explicit resume, acknowledgement, or Goal completed/replaced/cleared |

**Planner-confirmed failure frequency:** one item for every terminal failed
turn, not only a streak threshold. This includes failed queued turns while a
Goal is present, but excludes user cancellation, provider-internal retry
attempts and multiple failed reply slots inside the same turn. It is an attention notification,
not a new pause/retry policy. The existing same-mode/total-streak guards alone
decide automatic failure pauses. This prevents a first failed round from being
invisible; one item per turn bounds duplication. The planner can batch reads.

M4 planner clarification: both root `conversation_turn` (main lane) and root
`conversation_side_dispatch` (side lane) count. Reply child tasks and internal
retries do not. At root-task creation, persist the server-derived Goal ID and
revision from that task's starting context. At its terminal transition, create
attention only if the current live Goal has that same ID, using the terminal
Goal revision as the occurrence revision. A task started without a Goal cannot
be assigned to a later Goal; a task started before replacement/clear cannot
produce attention for the new Goal. Never infer association from a timestamp,
message body, client claim or the mere presence of a different current Goal.

A successful terminal transition can resolve only earlier failures for the same
Goal, same agent and same lane (`main` or `side`), ordered by durable terminal
commit, not turn start time. Another agent's or another lane's success is not
proof of recovery. Cancellation neither creates nor resolves attention. Other
scopes remain resolvable by explicit resume, acknowledgement or Goal
completion/replacement/clear; existing pause thresholds are unchanged.

Acknowledgement accepts a nonblank reason only for goal_completed/turn_failed
(400 `attention_reason_required` if absent/blank). Persist that reason alongside
the resolution principal in SQLite; it is not a new creation event or part of
the monitoring summary. It cannot hide a pending proposal or unresolved
budget/failure/owner condition (409 `attention_condition_active`). Already-resolved items return the same item
without another transition. Missing items return 404 `attention_not_found`.
No new Room UI for acknowledgements is required; the user can still handle the
underlying Goal/proposal in the current UI.

Goal/proposal/runner transitions, ruling archive and related attention
insert/resolution belong in the same SQLite transaction. Likewise Room creation
and its dedicated retry mapping commit together; no universal operation
receipts are needed. This applies to REST, agent tools, owner-removal checks
and system runner transitions, not only planner requests. Roll back on
persistence failure. Notify only after commit. Queue production uses durable
transitions, never SSE as its source of truth.

Startup reconciles current proposal, budget-limited runner, failure pause,
missing owner and completion from bounded metadata and stable occurrence keys.
Repair missing rows idempotently before serving attention reads; do not replay
all historical messages or fabricate old turn failures. New turn-failure rows
commit with terminal turn persistence. Interrupted-run reconciliation also
inserts attention for newly failed root tasks in that same transaction, but
only when a saved starting Goal association still matches the live Goal. Do
not backfill already-terminal historical tasks or guess the Goal association of
old-format tasks that did not persist one. Existing resolved rows are never reopened
just because a process restarted. Replacement/clear resolves outstanding items
from the retired Goal with an explicit resolution, retaining them for replay.
Room deletion may remove its items, but never resets the global sequence.

Review requests in ADR 0002 are represented in P1 by the milestone's pending
pause/complete proposal and its attention row. No heuristic extraction of public
text and no structured review-request source are introduced; the latter is P2.

## 6. Cursor list and long polling

Both list and wait accept:

- `after`: exclusive creation sequence, default `0`, nonnegative safe integer.
- `limit`: default 100, range 1–500; ascending sequence order.
- `conversationId`: optional exact Room filter.
- `status`: `all` (default), `unresolved`, or `resolved`.
- Wait only: `timeoutSeconds`, default 60, integer range 1–300.

**Planner-confirmed defaults:** 60/300 seconds. Invalid parameters return 400
`attention_query_invalid`; do not silently clamp a cursor.

```json
{
  "items": [],
  "nextCursor": 42,
  "highWatermark": 42,
  "hasMore": false,
  "timedOut": true
}
```

`highWatermark` is the database's committed attention creation sequence at the
query snapshot. If another matching row remains in that snapshot, nextCursor is
the last returned sequence and hasMore is true; otherwise nextCursor advances to
at least the snapshot watermark (and never below the input cursor). Gaps and
nonmatching items are safe to skip. Unfiltered `status=all` is the durable replay
mode: an item resolved while offline is still returned, with its resolution.
Rows are not dequeued on read. No automatic retention/pruning in P1.

The cursor tracks **creation**, not status-update events. Resolving an old item
does not assign it a new sequence; re-list unresolved items from after=0 or use
the portfolio count to refresh current workload. Do not promise a change-data
stream of every resolution. Clients must keep separate cursors for different
filters; advancing one filtered cursor does not consume another feed.

Wait runs the same query first: available rows return immediately with
`timedOut: false`. Otherwise register a waiter and re-check the DB to close the
read/subscribe race. Wake/re-query on committed changes until matching rows
exist or the deadline expires; unrelated Room events must not cause a false
nonempty result. Timeout is 200 with items=[], timedOut=true and a safe cursor,
not an error. Client disconnect removes listeners/timers; server shutdown ends
waits without fabricating items. Reconnect with the last successfully received
cursor. If the response was lost, re-reading may repeat rows but cannot lose
them. Clients deduplicate by sequence. SSE remains optional, non-replayable UI
transport and is not required for this protocol.

## 7. Bounded state and portfolio

`GoalState` has exactly these monitoring projections (null when absent):

```ts
{
  goal: null | {
    goalId, revision, status, objective, owner, createdAt, updatedAt, completedAt?,
    plannerBinding,
    decisionCounts,             // counts per decision group, not decision texts
    acceptanceCounts,          // pending/passed/failed/waived, highRisk
    workItemCounts,             // todo/in_progress/done
    evidenceCount
  };
  proposal: null | { id, action, baseRevision?, proposedBy, reason, createdAt, updatedAt };
  ruling: null | { id, proposalId, action, outcome, ruledBy, reason, ruledAt };
  runner: null | { /* existing normalized sessionGoalRunner, bounded summaries */ };
  busy: boolean;
  lastTurn: null | { id, status, startedAt, finishedAt, failureKind?, failureCode?, summary };
}
```

Objective is clipped to 2,000 Unicode code points; proposal/ruling reasons and
failure/turn summaries to 500. `plannerBinding` is the public binding, never a
credential. Last turn summary means status/error classification, **not** the
last message text, assistant output, reasoning or tool trace. No full proposal
snapshot, evidence bodies, arbitrary Room metadata, messages or private mailbox.
The complete authoritative contract remains available at the existing Goal read;
clients must not send this summary projection back as a replacement Goal.

State response is `{ conversationId, ...GoalState }`, at most **64 KiB of serialized
UTF-8 JSON**, independent of public/private message count or content length.
Counts are calculated from bounded Goal metadata. Use indexed terminal-run/header
reads for lastTurn and runtime lane state for busy (active/dispatching/queued main
or side work); do not fetch `listMessages()` to find the last round.

Portfolio returns every Room with a Goal (active, paused or complete), plus Rooms
with pending set proposals. Each item is
`{ conversationId, title, projectScopeId, state: GoalState, unresolvedAttentionCount }`.
Title is clipped to 120 code points. It is a server-side overview, not N client
requests or bootstrap hydration. Use bounded Room headers and grouped SQLite
unresolved counts. No message/history/profile/credential payloads. Per-item
budget remains 64 KiB plus 1 KiB of Room identity; total size is linear in Room
count (not a fixed global cap). `observedAt` marks the read; live busy state may
change immediately after it. Do not claim a transactional snapshot of OS runs.

Missing required bounded-store projections fail closed with 501
`planner_projection_unavailable`, never full-conversation fallback.

## 8. Errors and client recovery

| HTTP / code | Meaning and recovery |
| --- | --- |
| 400 `goal_revision_required` | Supply current ID/revision; null/0 only for first set or pending-proposal operations while no live Goal exists |
| 400 `goal_owner_invalid` | Choose a currently routable Room participant |
| 400 `goal_owner_reason_required` | Planner owner reassignment requires a reason |
| 400 `goal_initial_status_invalid` | Initial set status must be active or paused |
| 400 `goal_planner_binding_reason_required` | User adoption requires a nonblank reason |
| 400 `idempotency_key_required` | Supply a valid planner Room-creation retry key |
| 400 `attention_query_invalid` | Correct cursor/filter/timeout |
| 400 `attention_reason_required` | Supply a nonblank acknowledgement reason |
| 400 `goal_patch_invalid` | Invalid explicit patch value/type/required text; omission is not null |
| 400 `goal_acceptance_state_required` | Changed criterion definition needs explicit new acceptance state/proof fields |
| 400 existing Goal validation codes | Invalid definitions, missing verifyBy, evidence IDs/links or waiver reason; nothing written |
| 401 `planner_credential_invalid` | Missing/invalid declared planner credential; never downgrade to user |
| 403 `api_host_mismatch`, `api_origin_mismatch`, `api_csrf_invalid` | Browser/planner mutation guard failure, as applicable |
| 403 existing local-admin `*_local_only` | Existing local-only boundary remains |
| 403 `goal_high_risk_waiver_user_required`, `goal_accepted_adr_change_user_required` | Direct user ruling in CAFF required; attestation is insufficient |
| 403 `goal_high_risk_change_user_required` | Non-user cannot downgrade/delete an existing high-risk criterion; replacement set/clear may retire a completed Goal, but unfinished Goals and revise remain protected |
| 403 `goal_metadata_reserved` | Generic Room PUT cannot alter server-owned Goal/D28 binding metadata; use the Goal endpoint |
| 403 `goal_planner_ruling_required` | Room agent cannot rule on a planner-driven Goal |
| 403 `goal_planner_binding_user_required` | Only the user may adopt an existing Goal via bind-planner |
| 403 existing `goal_proposal_self_review`, DAG codes | Existing self-review/worker/verifier restrictions remain |
| 404 existing Room/Goal/proposal errors, `attention_not_found` | Read state again; do not invent an entity |
| 409 `goal_revision_conflict`, `goal_proposal_conflict` | Concurrent change or committed retry, or missing/mismatching required proposalId; read again and inspect before a new action |
| 409 `goal_planner_binding_conflict` | Goal already has a planner binding; no implicit replacement |
| 409 `goal_proposal_pending` | Rule first, or explicitly confirm and identify supersession |
| 409 `goal_structural_review_required`, `goal_waiver_review_required`, `goal_acceptance_incomplete` | Use reviewed revision / finish acceptance, not a factual or lifecycle shortcut |
| 409 `idempotency_key_conflict` | Room-creation key reused for a different semantic request |
| 409 `MESSAGE_IDEMPOTENCY_CONFLICT` | Existing message clientRequestId reused with different content/images |
| 409 `attention_condition_active` | Handle the underlying blocking state |
| 410 `conversation_gone` | Room-creation key refers to a deleted Room; no replay creation |
| 415 `api_json_required`, `api_multipart_required` | Correct route Content-Type; never bypass CSRF |
| 501 `planner_projection_unavailable` | Required bounded store capability unavailable; no hydration fallback |

Guard failures are pre-write. Invalid planner intent is checked before the
ordinary browser guard; a mismatching Host with a valid planner is still 403.
Content-Type and browser Origin/CSRF are checked before consuming the body.
Domain conflicts occur only after caller authentication. A multi-fault browser
request need not report every invalid header. Preserve existing admin error code
aliases where old clients depend on them; new global guard codes are canonical.

## 9. Compatibility, migration and verification

- SQLite changes are additive: attention, ruling archive and a scoped
  Room-creation deduplication mapping, not a generic operation-receipt table;
  indexes cover sequence/Room/unresolved counts and unique source keys. Keep
  existing Goal IDs, revisions, roster, evidence, runner counters and DAG binding.
- Legacy Goals stay unbound. Recognized old rulings remain readable; archive the
  current durable ruling idempotently on upgrade, without inventing a principal
  for previously unaudited actions. No historical planner attribution rewrite.
- User UI needs no planner credential. Updated shared clients cover **all**
  mutations, including image upload, bodyless deletion, workspace authorization
  and every management page. Preserve ordinary message dispatch and unbound Goal
  behavior apart from the explicit merge/409 corrections.
- Agent-tools remain invocation-authenticated. Feishu verification and webhook
  responses, native DAG completion, cross-Room delivery and delegation do not
  gain new features or weaken authentication.
- M5 synchronizes `session-goal.md`, the D28 section of `dag-execution.md`,
  `conversation-title.md`, controller/bootstrap/frontend guard contracts and any
  runtime documentation affected by the final implementation.

### Planner-confirmed decision: factual updates and session reuse

Current code always increments Goal revision on update-delivery. Goal Runner
reuse compares the trigger, current Goal and provider-known revision; resume
injects message delta only, not a fresh Goal section. Merely not bumping revision
or rewriting the provider-known revision would let the model act on unseen
criterion/evidence/ruling state. Accepting lifecycle or structural proposals is
not a factual-only change; even rejection changes review guidance.

**P1 retains current fresh-session behavior, confirmed by the planner.**
Batch factual writes and rulings, but do not implement a reuse exception. A later
optimization would need a separately specified versioned Goal-delta delivery/acknowledgement,
provider-known contract revision versus delivery revision, atomic claim/race
checks, restart coverage and prompt parity tests. That is not safe to hide inside
this P1 interface change. No reuse exception is implemented in P1. The planner
confirmed this and the per-turn failure/default choices in the M1 review; the
planner will update the Goal decision classifications after M1 passes.

### Acceptance evidence required during implementation

1. Credential/attribution HTTP tests: valid planner message/ruling; missing,
   wrong and malformed credentials with zero writes; forged body identity;
   planner rejection and user success for both user-only gates, including direct
   actions and replacement bypass attempts; rotation and secure-file failure.
   M3/R2 additionally covers planner and agent downgrade/delete/replacement
   attempts (403 without Goal/proposal/ruling mutation), user success for the
   same changes and unchanged normal-risk behavior. Include the actual agent
   callback/bridge acceptance path, not only a caller-supplied domain principal.
   M4/N8 covers retiring a completed high-risk Goal with direct/accepted set or
   clear, while unfinished Goals, revise, new high-risk waivers and accepted-ADR
   changes stay protected. M4/N9 covers unrelated updates and reopen with legacy,
   malformed or conflicting old ruling metadata, immutable archive preservation,
   sanitized conflict diagnostics and strict rollback for new ruling conflicts.
   M2 also requires the Windows command/ACE unit matrix and local isolated
   CodexSandboxUsers-no-read / valid-planner-auth check specified in §1; include
   sanitized diagnostics and results in the M2 review evidence. Cover default
   Windows/POSIX state paths, deterministic per-instance filenames, absolute
   overrides, unsafe ancestors and isolation from real user-state directories.
2. Mutation HTTP matrix: wrong Host, wrong/missing/null Origin, wrong/missing
   CSRF, non-JSON; image upload missing CSRF and cross-origin rejected; browser,
   planner, callback, webhook and multipart successes; existing local-only
   restrictions. UI/smoke cover chat, Goals, Room creation, workspace authorization,
   models/projects/skills management and image upload with the shared token.
   Cover all three loopback aliases, same-alias Origin/Host success, cross-alias
   rejection, exact non-loopback matching, and unchanged admin read restrictions.
3. Runtime/HTTP tests: owner invalid/paused/no enqueue/first target; manual title
   survives first message and refinement; each of five guarded actions' 409 and
   supersede paths with archived snapshot/identity; omission, explicit empty,
   item-field preservation, full old payload, stale revision/proposal and retry.
   No-live-Goal initial set accept/dismiss/supersession uses null/0 plus matching
   proposalId; missing IDs and zero revision with a live Goal fail unchanged.
   Agent proposal replacement archives old snapshot/identity/new proposal ID
   atomically; M4 also tests old/new attention transitions and durable replay.
4. Bridge/HTTP/DAG tests: bound planner/user rulings allowed, every agent ruling
   rejected; unbound and DAG worker/verifier/scheduler/user behavior unchanged.
   User bind-planner preserves Goal ID/content/counters and bumps revision;
   non-user, stale, pending-proposal and DAG binding attempts are rejected.
   The M3 Goal-panel adoption entry requires confirmation, sends the user/CSRF
   request, and leaves state unchanged on cancellation.
5. Storage/runtime tests: each attention source, deduplication, same-transaction
   rollback, restart recovery and resolution; budget item with another pending
   proposal. Include no-Goal set proposals: null/0 occurrence identity survives
   restart and acceptance/dismissal/supersession, with only resolution fields
   updated. No-Goal failed turns produce no attention; portfolio still includes
   Rooms whose only Goal state is a pending set proposal. HTTP wait arrival, timeout, disconnect race, multi-page cursor
   replay (including resolved offline rows), acknowledgement restrictions.
6. HTTP/storage projection tests: exact summaries, no message/private/tool data,
   64-KiB state bound for huge Rooms, grouped portfolio unresolved counts and
   absent bounded-store capabilities fail closed.
7. Before each milestone review run the full applicable checks: typecheck,
   npm test (fast + smoke), test:dag-execution, git diff --check. Use temporary
   SQLite/agent directories, random ports and synthetic executors only; no
   3100/3200, real credentials, provider calls or Feishu side effects. Keep test
   logs/media in the system temporary directory. Integration additionally needs
   planner PASS at the exact SHA and separate user push/PR/merge authorization.
