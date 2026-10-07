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
  - 2026-10-06, commit `71634b7`: admin account management shipped (handoff
  item 1). Five `/accounts/*` routes on the space AuthManager, gated against
  the shared Accounts store the space's delegated Authentication already
  holds (no hub reference enters a space); admin-only taskbar Accounts
  button + shell dialog (create / role / disable-enable / password reset).
  243/243 `bun run verify` green (6 new wire-level tests, including
  non-admin refusal, bogus/anonymous refusal, last-admin protection). Still
  no visual browser pass (wire/SSR tests only; open the Desktop by hand).
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
- `source/server/core/assistant/rag.ts` + `embeddings.ts` + `rag-tools.ts` —
  **built-in RAG** (2026-10-06): each space keeps `assistant-rag.sqlite`
  (chunks + Float32 vectors, cosine-scored). Embeddings come from the SAME
  OpenAI-compatible endpoint (`SERAPH_LLM_EMBED_MODEL`, default
  `nomic-embed-text`); the assistant's catalog gains `files_index` (a file or
  a whole directory, paragraph ~800-char chunks with 100-char overlap,
  re-index replaces stale chunks) and `files_search` (top-k excerpts with
  paths), always as the signed-in user inside their own space. No new
  dependency; tools absent when no endpoint is configured.
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

1. DONE (2026-10-06, commit `71634b7`) — Admin UI for account management: five
   `/accounts/*` admin-gated routes on the space AuthManager + admin-only
   taskbar Accounts button and dialog in the shell layer. Wire-level tests
   cover admin lifecycle, non-admin/bogus/anonymous refusals, last-admin
   protection. PLAN.md Phase 2 item 5 ticked.
2. **Assistant write confirmation** — `files_write` and `desktop_set_theme`
   act immediately; the confirmed design (dialog per write) is in PLAN.md.
3. DONE (2026-10-06) — Assistant as Program: Hub seeds a per-space seraph
   Program (create-only-if-missing, upgrade-safe) making the native
   SeraphChat window launchable from the Start menu like any Program;
   assistant routes stay space-scoped. Wire tests cover seeding, client-
   endpoint launch, restart stability, per-space isolation, and corrupted-
   seed tolerance.

4. DONE (2026-10-06) — Gateway authenticates per session: every peer first sends
   `/gateway/authenticate` {token}; the System resolves it through the session
   index and requires a live, non-disabled administrator account; only then it
   binds the external boundary and pushes `/gateway/ready` (shape unchanged).
   Refusals answer the call itself (none/non-admin/disabled/unknown,
   out-of-order) and the door closes. Sign-out kills the token's minting
   power: a dead session can never bind a new peer. Tests cover the
   handshake, four refusal classes, order-abuse, and sign-out.

5. DONE (2026-10-06, this session) — Visual/desktop pass in a real headless
   Chrome (CDP-driven): fresh browser → 'Create your account' bootstrap screen
   renders with no console errors → sign-up → live Desktop (taskbar: start
   menu, map, Accounts button, Sign out) → Accounts dialog in pixels (row:
   role, disabled state, created date; role/disable/reset controls; create
   form with role User/Admin) → Start menu shows Programs: 1 → the seeded
   Seraph card launches → the native SeraphChat window opens in pixels
   (correctly showing its no-model state; full chat/dialog pixels need a
   configured SERAPH_LLM_BASE_URL and remain the one pixel-check TODO).
   Screenshots in %TEMP% (seraph-desktop-signedin.png,
   seraph-chat-window.png). The pass also FIXED a real first-boot crash the
   suite never caught: the gate's subscribe acknowledgement carried
   `appearance { value: null }`, the anonymous stage painted
   `signInWallpaper` from it and React died before the sign-in UI; the ack
   now carries `defaultAppearance` (gate.acknowledgement in hub-gate.ts).

6. DONE (2026-10-06) — Upstream sync: upstream moved only one release beyond
   the fork point (`0.1.117` → `0.1.118` + one test-timing commit, `9ce159b`).
   Both changes applied: `@the-link/http` `^0.2.1` (lockfile bumped) and the
   slow-machine expiry-test timing in `tests/program-store.test.ts`. No
   conflicts — none of the fork's patch surface overlaps. Next sync point:
   upstream `main` (`9ce159b`) is the last change as of this date.

7. DONE (2026-10-06) — Signed releases: `pack.ts` signs the archive Ed25519
   when `SERAPHOS_RELEASE_KEY` points at the operator's signing PEM
   (`seraphos@x.zip.ed25519.sig` beside the sha256), `scripts/verify-release.ts`
   verifies archive + signature for consumers, `scripts/release-keygen.ts`
   mints the pair once, and the verifying half is committed as
   `scripts/release-public.pem`. Unsigned-by-default keeps unattended verify
   green; a configured-but-missing signing PEM fails the pack instead of
   silently shipping an unsigned artifact.

8. DONE (2026-10-07) - Connectivity: the assistant can reach MCP servers,
   HTTP APIs, and the public web. Seven new tools (connections_save/list/
   remove, api_call, mcp_list_tools, mcp_call_tool, web_fetch); connections
   live per-space in `users/<name>/assistant-connections.sqlite` with secrets
   held server-side (every view says hasKey, nothing ever echoes a token).
   MCP speaks Streamable HTTP hand-rolled over fetch (initialize ->
   Mcp-Session-Id -> tools/list -> tools/call; SSE-framed replies parse
   like JSON; zero new dependencies). web_fetch runs through an SSRF guard
   (private/loopback/link-local/metadata addresses refused, redirects
   re-validated every hop, 512 KB cap; known residual: DNS-rebinding
   TOCTOU). State-changing asks (save/remove connections, mcp_call_tool)
   confirm in the Desktop like files_write; the confirm union widened, no
   client change needed. Four /connections/* routes exist for a future
   Desktop settings dialog. stdio MCP transports deliberately deferred.
   287/287 verify (83 files; 14 new tests in two suites).

## Environment (all optional; System runs without any)

`SERAPHOS_HOME` (state root), `SERAPHOS_PORT` (list/ranges), `SERAPHOS_HOST`
(bind interface), `SERAPH_LLM_BASE_URL`, `SERAPH_LLM_API_KEY`,
`SERAPH_LLM_MODEL`, `SERAPH_LLM_EMBED_MODEL` (embeddings for RAG).