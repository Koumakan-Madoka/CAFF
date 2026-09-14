# Subscription OAuth Login (anthropic / openai-codex)

Engineering notes for the「通过订阅登录」feature: CAFF backend drives
pi-ai's OAuth login flows for the `anthropic` (Claude Pro/Max) and
`openai-codex` (ChatGPT Codex) providers and persists credentials into the
shared agentDir `auth.json` consumed by the pi runtime.

Research source: `@earendil-works/pi-ai@0.84.3` and
`@earendil-works/pi-coding-agent@0.84.3` (the exact versions CAFF pins).

## Login flow modules

| | anthropic | openai-codex |
|---|---|---|
| Module | `pi-ai/dist/auth/oauth/anthropic.js` | `pi-ai/dist/auth/oauth/openai-codex.js` |
| Loader | `loadAnthropicOAuth()` from `@earendil-works/pi-ai/oauth` | `loadOpenAICodexOAuth()` from `@earendil-works/pi-ai/oauth` |
| Authorize URL | `https://claude.ai/oauth/authorize` | `https://auth.openai.com/oauth/authorize` |
| Token URL | `https://platform.claude.com/v1/oauth/token` | `https://auth.openai.com/oauth/token` |
| Redirect URI | `http://localhost:53692/callback` | `http://localhost:1455/auth/callback` |
| Callback host | `PI_OAUTH_CALLBACK_HOST` env, default `127.0.0.1` | same |
| PKCE | S256, `state` = verifier | S256, random 16-byte hex `state` |
| Extra | manual paste fallback (`manual_code` prompt) | browser **or** device-code flow, chosen by a `select` prompt; manual paste fallback |

Both flows are Node-only (`node:http` callback server) and are loaded through
lazy loaders so bundlers do not follow them into browser builds. CAFF's server
is Node-only, so this is not a constraint.

## AuthInteraction contract (what CAFF must implement)

Defined in `pi-ai/dist/auth/types.d.ts` (`AuthInteraction` /
`ProviderAuthInteraction`):

```ts
interface AuthInteraction {
  signal?: AbortSignal;                    // aborts the whole login
  prompt(prompt: AuthPrompt): Promise<string>;  // rejects on cancel/abort
  notify(event: AuthEvent): void;          // auth_url / progress / info / device_code
}
```

CAFF's backend interaction adapter:

- `notify({ type: "auth_url", url })` → forward the URL to the waiting
  frontend (login session state), which opens the browser.
- `prompt({ type: "select", ... })` → only used by openai-codex to choose
  browser vs device-code; the adapter answers `"browser"` directly without
  surfacing a UI choice (matches the confirmed mock UI).
- `prompt({ type: "manual_code", ... })` → stays pending while the callback
  server waits; **must reject when the login session aborts**, otherwise the
  flows' `await manualPromise` path deadlocks after a cancel (see pitfalls).
- `signal` → tied to the CAFF login-session AbortController (user cancel,
  server shutdown).

### Pitfall: manual-code race and cancellation

Both flows race the callback server against the `manual_code` prompt:

1. On user cancel, `interaction.signal` aborts → `server.cancelWait()` →
   `waitForCode()` resolves `null` → flow does `await manualPromise` and only
   throws after it settles. The prompt's own `signal` is a *separate*
   `manualAbort` controller the flow aborts in `finally` — i.e. never while
   awaiting. Therefore CAFF's `prompt()` implementation must also reject when
   the **login session** aborts, or a cancelled login hangs forever.
2. On openai-codex, if callback port 1455 is already taken, the flow silently
   degrades to the manual-paste path (`waitForCode` → `null` immediately).
   With no paste UI this hangs until cancel. Mitigation: pre-check both
   callback ports before starting a login and fail fast with a clear error.

## Credential format written to auth.json

Verified against `pi-coding-agent/dist/core/auth-storage.js`
(`AuthStorage` / `FileAuthStorageBackend`) — the exact writer pi uses:

- File: `<agentDir>/auth.json`, a JSON object keyed by **provider id**
  (`"anthropic"`, `"openai-codex"`).
- Serialized as `JSON.stringify(data, null, 2)`, written with mode `0o600`,
  parent dir `0o700`, guarded by `proper-lockfile` (sync retry 10×20ms, async
  stale after 30s).
- OAuth credential shape (validated by `ReadOnlyAuthStorage.load`):

```jsonc
{
  "anthropic": {
    "type": "oauth",
    "access": "<access token>",
    "refresh": "<refresh token>",
    "expires": 1234567890123   // epoch ms; anthropic subtracts a 5-min skew
  },
  "openai-codex": {
    "type": "oauth",
    "access": "...",
    "refresh": "...",
    "expires": 1234567890123,
    "accountId": "<chatgpt_account_id from access-token JWT claim
                   https://api.openai.com/auth>"   // codex-only extra field
  }
}
```

- `expires`: anthropic = `now + expires_in*1000 - 5*60*1000`; codex =
  `now + expires_in*1000` (no skew).
- Token refresh is **pi runtime's job** (locked `modify()` refresh pattern in
  pi-ai `Models`); CAFF never refreshes.

CAFF integration options for writing:

- Preferred: import `AuthStorage` behavior by writing through the same
  contract — either reuse `AuthStorage.create(authPath)` (exported surface:
  `readStoredCredential` is public; `AuthStorage` is exported from
  `pi-coding-agent` internals — verify export path at implementation time) or
  implement a minimal locked writer that produces byte-identical output
  (2-space JSON, 0600, proper-lockfile). Decision: **minimal locked writer in
  CAFF** matching the format above, because CAFF already owns models.json
  atomic-write infrastructure and must not depend on pi internals beyond the
  public API.
- Logout = delete the provider key from the object (keep other providers
  intact).

## Provider registration (models.json)

- pi's `ModelRuntime` always registers builtin providers (including
  `anthropic` and `openai-codex`) regardless of models.json — so OAuth login
  itself works without any models.json entry (`Models.login` resolves the
  builtin provider's `auth.oauth`).
- CAFF's provider list UI is driven by the models.json document
  (`readModelProviderDocument(agentDir)` → `providers` record). Therefore the
  confirmed UX ("openai-codex appears in the list only while logged in")
  requires registering an `openai-codex` entry into models.json on login and
  removing it on logout.
- models.json shape (pi `ModelConfig` schema): `{ "providers": { "<id>": {
  "name"?, "baseUrl"?, "apiKey"?, "api"?, "models"?: [...] } } }`. CAFF
  already validates writes against pi's schema via
  `lib/pi-model-config-validator.mjs`.
- Codex model list source: `OPENAI_CODEX_MODELS` from
  `@earendil-works/pi-ai/providers/openai-codex.models` (public `./providers/*`
  export), generated from `providers/data/openai-codex.json` (api
  `openai-codex-responses`, baseUrl `https://chatgpt.com/backend-api`).
  The registration entry should carry these models; no `apiKey` field (auth
  comes from auth.json).
- anthropic needs no models.json registration: imported/configured
  `anthropic` providers keep pi's builtin OAuth capability
  (`composeOAuthAuth` prefers `base.auth.oauth`), and stored auth.json
  credentials take precedence over env API keys.

## Callback port strategy (decision)

Fixed ports, **not** dynamically allocated:

- The redirect URIs (`localhost:53692` / `localhost:1455`) are hardcoded in
  the OAuth client registrations (and in pi-ai's module constants); dynamic
  ports are impossible without owning the OAuth apps.
- Both bind `127.0.0.1` by default; `PI_OAUTH_CALLBACK_HOST` can override the
  host but not the port.
- CAFF backend pre-checks port availability (bind-and-release or netstat)
  before invoking `login()` and returns an actionable error on conflict
  ("port 1455 已被占用，可能已有一个登录流程在进行，或另一个程序占用了该端口").
- Only one login flow per channel can run at a time; concurrent start
  requests for the same channel are rejected while one is pending.

## Backend integration points (CAFF)

- Status: extend the existing external-auth detection
  (`readExternalAuthProviderIds`) — no schema change needed; a provider id in
  auth.json with `type: "oauth"` = subscription logged in.
- Start login: new controller route creating an in-memory login session
  (id, channel, state: `waiting_browser | exchanging | success | error |
  cancelled`), driving `loadXOAuth().login(interaction)`; the frontend polls
  session state (same pattern as existing long-running operations).
- Logout: delete auth.json key (locked write) + remove the
  `openai-codex` models.json registration for the codex channel; anthropic
  logout only removes the credential.
- No OAuth secrets enter the CAFF database; auth.json remains the single
  credential store.

## Implementation record (work-2 / work-3)

Backend landed on the room branch with three modules and one controller:

- `server/domain/models/subscription-auth-store.ts` — auth.json persistence.
  Mirrors pi's `FileAuthStorageBackend` byte-for-byte: 2-space JSON without a
  trailing newline, `writeFileSync` mode 0600 (parent dir 0700), and a
  `proper-lockfile` lock (`realpath: false`, `retries: 0`, `stale: 30s`,
  ELOCKED retry with pi's backoff curve) so CAFF writes serialize against
  pi runtime token refreshes. `proper-lockfile@4.1.2` is now a direct CAFF
  dependency (previously only a transitive pi-coding-agent dep). Credential
  shape is validated before writing (`{type:"oauth", access, refresh,
  expires[, accountId]}`); malformed existing auth.json fails closed.
- `server/domain/models/subscription-login.ts` — login/logout orchestration.
  - The pi-ai OAuth flow modules (`dist/auth/oauth/{anthropic,openai-codex}.js`)
    are Node-only and **not** exposed through pi-ai's `package.json` exports;
    they are loaded by file URL from the pinned dist tree (same precedent as
    `lib/pi-model-config-validator.mjs` reaching into pi-coding-agent dist).
    Dynamic import goes through `Function('specifier', 'return
    import(specifier)')` so tsc's commonjs output cannot rewrite it to
    `require()` (same pattern as `conversation-digest.ts`).
  - Interaction adapter: `select` prompts (codex browser/device-code) are
    answered `"browser"` directly; `manual_code` prompts stay pending and
    reject on login-session abort (the deadlock pitfall above); `text` /
    `secret` prompts are rejected as unsupported.
  - Port pre-check binds-and-releases the channel's callback port on the
    `PI_OAUTH_CALLBACK_HOST` (default 127.0.0.1) before `login()` starts;
    failure maps to `callback_port_unavailable`. One active login per
    channel; `login_in_progress` otherwise.
  - Codex login success registers the `openai-codex` provider entry into
    models.json via the existing `updateModelProviderDocument` write path
    (CAFF schema + pinned pi schema validation, backups, write queue). The
    model list comes from `OPENAI_CODEX_MODELS`
    (`@earendil-works/pi-ai/providers/openai-codex.models`, a public export);
    entries carry id/name/api/baseUrl/reasoning/input/contextWindow/maxTokens
    and no apiKey. Logout removes the entry again; anthropic never touches
    models.json.
  - `dispose()` aborts in-flight logins; wired into `createServerApp.close()`.
- `server/api/subscription-auth-controller.ts` — HTTP surface, loopback/Host/
  Origin/CSRF guarded like the model-providers controller (`subscription_auth`
  issue prefix):
  - `GET /api/subscription-auth` → `{channels:[{channel,loggedIn,expiresAt,
    accountId}], logins:[active sessions]}` (no credential payloads).
  - `POST /api/subscription-auth/logins` `{channel}` → starts a session;
    errors map to 400 `channel_unknown`, 409 `login_in_progress` /
    `callback_port_unavailable`, 422 missing channel.
  - `GET /api/subscription-auth/logins/:id` → session snapshot
    (`starting|waiting_browser|exchanging|success|error|cancelled`, authUrl,
    sanitized error, capped event log); 404 when pruned/unknown.
  - `POST /api/subscription-auth/logins/:id/cancel` → aborts the flow and
    settles the session as cancelled.
  - `POST /api/subscription-auth/logout` `{channel}` → removes the auth.json
    credential (and the codex models.json entry), returns
    `{channel, credentialRemoved, modelsUpdated}`.

Verified live against the real pi-ai anthropic flow on an isolated instance:
login start bound port 53692 and produced the real `claude.ai/oauth/authorize`
URL, duplicate start rejected 409, cancel released the port, and logout
reported `credentialRemoved:false` when never logged in.

Tests (added to `test:fast`): `tests/runtime/subscription-auth-store.test.js`
(byte format, lock interop, fail-closed cases), `tests/runtime/
subscription-login.test.js` (fake flows: success/cancel/error paths, prompt
contract, port pre-check, concurrency, codex registration + logout cleanup),
`tests/http/subscription-auth-controller.test.js` (guard gating, error
mapping, secret-blind responses).

## Frontend (work-4)

`public/personas/subscription-login.js` replaces the confirmed mock
(`public/personas/oauth-login-mock.js` and the v1 prototype pages were
deleted; the entry button `#official-channel-login` is unchanged).

- Channel view in the provider detail pane renders from
  `GET /api/subscription-auth`: per-channel login state (accountId/expiry for
  codex, expiry for anthropic), browser-login/logout actions, codex-only
  "view provider" shortcut, and a resume path for in-flight sessions
  (recovery after a page reload mid-login).
- Login dialog drives the real session API: `POST …/logins` on open,
  `GET …/logins/:id` polled at 1.2 s, step markers derived from session state
  (`starting→pkce`, `waiting_browser→callback`, `exchanging→exchange`), the
  real authorize URL displayed with an open-browser button (the page attempts
  one `window.open` when the URL first appears — the server cannot open a
  desktop browser from an HTTP handler), and cancel via `POST …/cancel`.
  Closing the dialog (X / backdrop / Escape) cancels an in-flight session so
  the callback port is released instead of lingering.
- Display rules (user-confirmed) live in `provider-management.js` /
  `provider-editor.js` and rely on the existing provider projection:
  - Rows with `hasExternalAuth` append "OAuth external" and render the status
    dot as configured; the openai-codex row additionally gets the 订阅 tag,
    the "订阅登录注册" meta label, and the `CD` mark.
  - The provider count appends "含 N 个订阅条目" only while external
    credentials exist.
  - anthropic detail (real editor) renders a subscription block (label,
    account, expiry, logout button) fed by the status API; the generic
    external-auth note now points to 通过订阅登录 when channel info exists.
  - openai-codex detail is a read-only subscription view (registered and
    removed by the login itself) with a real "validate connection" action.
- After login/logout the provider list is refreshed in place
  (`reloadProvidersList`) without stomping the active detail pane; downstream
  consumers refresh through the existing `onProvidersChanged` hook.

Evidence (isolated preview instance, port 3210, headless Edge):
- Logged-out: list shows zero subscription artifacts; channel view renders
  both channels; starting a real anthropic login from the UI produced the
  real `claude.ai/oauth/authorize?…code_challenge=…` URL, the dialog showed
  the waiting_browser step state, a concurrent second start was rejected
  409, and cancel rendered "未写入任何凭证" (15/15 checks, one pre-existing
  favicon 404 excluded).
- Logged-in (fake credentials seeded into the isolated agentDir auth.json in
  the exact stored shape): anthropic row/detail markers, codex row tag +
  registration label + read-only detail with account id, count note, channel
  view 2/2, anthropic logout removing only the marker/credential, codex
  logout removing credential + models.json entry and restoring the clean
  list (17/17 checks).
