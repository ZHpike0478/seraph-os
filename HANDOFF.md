# Seraph OS — Engineering Hand-off

Date: 2026-10-05. Built by steph with Perplexity Computer (Hermes agent).

## What this repository is

Seraph OS is a multi-user web desktop: a Node server that hosts each user's
programs, file storage, and an AI assistant, and a browser Desktop each user
signs into individually. One repo contains the whole System:

- `source/server` — the authoritative runtime ("the System")
- `source/client` — the React Desktop the browser loads
- `source/shared`, `source/libs` — cross-cutting contracts and utilities
- `tests/` — 71 files, behavioral and boundary-focused

**Provenance.** Fork of [PhreshOS/system](https://github.com/PhreshOS/system)
at release 0.1.117 (commit `b9c6185`, MIT, © 2026 Zohayr SLILEH). The fork
kept upstream's MIT license with dual copyright in `LICENSE`, attribution in
`README.md`, and — deliberately — the upstream SDK contract internals:
`__PHRESHOS_SERVER_TRANSPORT__`, `__phreshos*` sandbox transport calls, and
the `@phreshos/core` + `@phreshos/react-ui` published dependencies. Do not
rename those; program SDKs speak that exact wire.

## Verified state (as handed off)

- `bun run verify` green: type-check, build, **237/237 tests**, including a
  distribution test that packs the release, installs it to a temp folder, and
  boots it (`tests/distribution.test.mjs`).
- Ten commits, clean tree. History starts at
  `991c231` (pre-rebrand snapshot) so the upstream diff is always reviewable.
- Live-wire verification: real messagepack WebSocket clients drove `/link`
  end-to-end (subscribe ack → anonymous owner state → bootstrap sign-up →
  session token push → second-connection sign-in → bound RPC) against the
  built server on port 6499. Browser-console-level visual verification was
  NOT done (browser tooling was unavailable); open the Desktop once by hand
  before trusting pixels.

## The architecture in one page

The load-bearing decision: **isolation by construction, not by filtering.**

- **Hub** (`source/server/core/hub.ts`) — the multi-user registry. One
  **Application instance ("space") per account**, lazily opened, cached in
  `Hub.spaces`. A space has its own home dir (`SERAPHOS_HOME/users/<name>/`),
  its own Keyv store, programs, processes, file areas, uploads, appearance,
  and session store. Nothing in a space can name another space; there is no
  shared mutable registry to leak through.
- **Gate** (`source/server/core/hub-gate.ts`) — the front door on `/link`.
  Every browser connection starts unbound. Pre-auth it answers exactly four
  events from the Hub: `/owner/state`, `/owner/sign-up` (bootstrap admin,
  refused after the first), `/owner/sign-in`, `/session-authenticate`
  (token → `Hub.sessionUsername` → bind to that token's space). After
  binding, the gate is a pure relay between socket and the space's own
  LinkManager. The gate exposes the boundary to its space with a synthetic
  anonymous `/session-authenticate(null)` — upstream's sign-in path requires
  an exposed boundary; keep that call when touching `Gate.enter`.
- **Accounts** (`source/server/core/accounts.ts`) — SQLite, admin/user roles,
  scrypt N=16384/r=8/64B (same shape as upstream's credential file, so a
  migration needs no rehash), case-sensitive usernames, NFKC+trim
  normalization, traversal-safe usernames (no `/\\`, no leading-dot),
  last-admin demotion/disable lockout, serialized writes.
- **Session index** (`sessions-index.sqlite` at the home root) — token hash →
  username, so a returning browser routes to its space before that space
  says anything. Expired/signed-out tokens are forgotten there on refusal.
- **Doors** (`source/server/view/http/`) — storage, proxy, uploads, and
  program assets all resolve the `authorization` header through
  `Hub.spaceForTokenByHeader` and answer from that caller's space only.
  Each space also keeps its **System-storage native root inside the space**
  (`users/<name>/system`), because a shared server has one OS user and the
  upstream homedir-rooted native area would be a cross-user channel.
- **Gateway** (`source/server/view/gateway/`) — loopback Unix socket / named
  pipe; peers act as the administrator through the first live admin space.
  Per-session gateway auth is a known gap (see below).
- **Header wall** (`source/server/view/http/hardened.ts`) — applied to every
  response: CSP `default-src 'self'` + `frame-ancestors 'self'` +
  `object-src 'none'` + `base-uri 'none'`, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`. Doors that need to loosen one
  directive (program assets' `Access-Control-Allow-Origin: *`, the wallpaper
  document's own CSP) set their header after the middleware; the wall only
  fills what is absent.

## The assistant (Seraph)

- `source/server/core/assistant/memory.ts` — per-space SQLite: conversation
  history (trimmable) + long-term facts (keyword recall, forgettable).
  Lives at `users/<name>/assistant.sqlite`.
- `source/server/core/assistant/assistant.ts` — OpenAI-compatible streaming
  client (SSE, `data:` lines, `[DONE]`), up to 8 chained tool rounds,
  streamed tool-call argument accumulation (fragments append by call id —
  real streams split one JSON argument across many deltas), history window
  of 40 messages. Config: `SERAPH_LLM_BASE_URL` (required to enable),
  `SERAPH_LLM_API_KEY` (optional), `SERAPH_LLM_MODEL` (default `llama3.2`).
  Works with Ollama/vLLM/NIM/OpenRouter.
- `source/server/core/assistant/tools.ts` — tools run as the signed-in user
  inside their space: `files_list/files_read/files_write` (space System
  storage root, 256 KB read cap), `programs_list`, `desktop_set_theme`
  (appearance update), `memory_remember/memory_recall` (space memory).
- `source/client/view/programs/seraph-chat.tsx` — the chat window; the
  Desktop renders it natively (no iframe) when a process's program name is
  `seraph` (`process-window.tsx` seam). Streams via `/assistant/chunk`
  boundary pushes; empty-delta sentinel means done.
- RPC routes live in the server AuthManager: `/assistant/state`, `/history`,
  `/turn`, `/forget`, `/clear`.

## Wire contracts worth remembering (debugged the hard way)

- `/link` subscribe: client sends `?payload=` as **base64url of raw
  messagepack bytes** of `{ current: payload }` (no `encodeURIComponent`).
- Subscribe ACK frame: messagepack `{ type: "subscribe", data }`.
- Server push frames: `{ type: "message", data: [event, ...values] }`.
- Client → server frames: raw messagepack array `[event, responseUuid, ...values]`.
- RPC replies ride the client's inbound under the literal `responseUuid` as
  `RequestOutcome` (`{success, result|error}`); `null` responseUuid means
  one-way (route once, never acknowledge).
- The client builds its transport from the subscribe ACK payload; appearance
  Property updates arrive as `property-update:<key>`. The gate publishes
  every space update under the fixed key `seraphos.gate.appearance` and
  pushes the space's current appearance right after binding (value is `null`
  until then). If you change the ACK shape, audit
  `structure.tsx` (`new LinkManager(application, link, link.payload, ...)`)
  and `authentication.tsx` (`session.update(token)` — token in localStorage).
- Vitest fork pool swallows stdout: assert, don't log, when debugging tests.

## Running it

```sh
cd system
bun install --frozen-lockfile
bun run dev          # Desktop on first free port from 6300, data in storage/
```

First visit creates the administrator. Service layout, environment table,
TLS termination, and the data layout are in `RUNBOOK.md`.

## Verification workflow

`bun run verify` before any push. Windows-specific notes baked into the
suite: close every SQLite handle (`Accounts.close`, `Application.close`,
`AssistantMemory.close`) before `rm`ing a home dir; temp-dir cleanup is
best-effort (`maxRetries: 10, retryDelay: 100`, wrapped in try) because
Windows holds fresh handles; `parsePorts` test-cases must be re-derived
after any port-range rename (a bad rename once produced a "valid" range).

## Known gaps / suggested order of work

1. **Admin UI for account management** — the store has
   create/reset/setRole/setDisabled but no Desktop screens and no `/accounts/*`
   admin-gated RPC routes; bootstrap admin exists, management is manual.
2. **Assistant write confirmation** — `files_write` and `desktop_set_theme`
   act immediately; the confirmed design (dialog per write) is in PLAN.md.
3. **Assistant as Program** — the chat window works, but `seraph` is not yet
   an installable Program with its own Server Endpoint; it is a Desktop-built
   view over AuthManager routes. Moving it under the Program model makes it
   openable from the Start menu like anything else.
4. **Gateway authenticates per session** — the loopback socket currently
   trusts transport-level isolation (same as upstream's owner model); bind
   gateway peers to an explicit admin token before multi-tenant hosts.
5. **Visual/desktop pass** — sign-up→desktop first-boot flow in a real
   browser, theme transitions with the gate's appearance re-key, assistant
   window in an actual Desktop session.
6. **Upstream sync** — upstream is an active repo (0.1.117 → newer). The
   fork's patch surface for rebases is exactly: accounts.ts, hub.ts,
   hub-gate.ts, authentication.ts (delegated mode), application.ts
   (initialize signature), the four http doors, gateway.ts, view.ts,
   hardening, identity/branding, process-window.tsx (assistant seam),
   link-manager.ts (`onSessionToken`), auth-manager.ts (assistant routes).
   PLAN.md holds the living list.
7. **Signed releases** — `pack.ts` emits zip+sha256; add signing/provenance
   before distributing binaries to anyone else.

## Environment (all optional; System runs without any)

`SERAPHOS_HOME` (state root), `SERAPHOS_PORT` (list/ranges), `SERAPHOS_HOST`
(bind interface), `SERAPH_LLM_BASE_URL`, `SERAPH_LLM_API_KEY`,
`SERAPH_LLM_MODEL`.