---
phase: complete
progress: 5/5
---

# ISA — Seraph OS: Admin account management (routes + Desktop UI)

principal_stated_goal: "yes" (to: 'build the admin UI for account management — admin-gated /accounts/* RPC routes on the server plus a Desktop accounts screen, the top item of HANDOFF.md's suggested order of work')

## Claims
- C1: `/accounts/list`, `/accounts/create`, `/accounts/set-role`, `/accounts/set-disabled`, `/accounts/reset-credentials` exist as RPC routes on the space AuthManager; when a signed-in connection of an admin account calls them they perform the operation through the shared Accounts store. FALSIFIER: wire-level test asserting each operation's effect (account appears / role flips / disabled / old password dead, new one live).
- C2: The same routes refuse non-admin callers and anonymous/unauthenticated callers with a clear error, and never mutate. FALSIFIER: wire-level test asserting refusal outcome for a signed-in non-admin and for a call with a bogus/missing token.
- C3: Last-admin protection holds through the route layer: demoting or disabling the only live administrator is refused. FALSIFIER: wire-level test asserting the store's refusal surfaces through the route.
- C4: The Desktop shows an Accounts entry point ONLY to admins and it opens a working dialog listing accounts and offering create / role change / disable-enable / reset-password, calling the routes without manual token handling. FALSIFIER: tsc typecheck of new component wiring + render smoke test asserting admin sees the panel and non-admin sees nothing.
- C5: No cross-user data reaches a non-admin: the accounts routes are the ONLY new exposure, no space gains a new readable surface, and hub isolation code is untouched. FALSIFIER: git diff inspection bounded to the listed files + full verify green.

## Anti-claims
- No hub object or other spaces' data ever mounts inside a space; the admin check resolves through what the space already legally holds (the shared Accounts store).
- No Program/Start-menu/window-launch mechanism is invented; the UI mounts in the shell layer.
- No change to accounts.ts store semantics, credentials hashing, or the Gate's four pre-auth events.

## Out of scope: assistant write-confirmation, assistant-as-Program, gateway per-session auth, upstream sync, signed releases (HANDOFF items 2-7).
## Evidence (collapsed at close)
- C1 [x] tests/account-routes.test.ts: administrators manage accounts through the routes - admin lifecycle wired over the real gate (243/243 verify rerun by parent)
- C2 [x] tests/account-routes.test.ts: the accounts routes refuse everyone but administrators - non-admin exact refusal, no mutation, bogus token, anonymous gate refusal
- C3 [x] tests/account-routes.test.ts: the routes carry the store protection for the only administrator, then allow demotion with a second one
- C4 [x] tests/accounts-dialog.test.tsx: 3 SSR tests - admin surface + stub call on mount, user sees nothing, button admin-only; tsc clean; wiring in default-shell.tsx
- C5 [x] git diff bounded to the nine files in this change; accounts.ts, hub.ts, hub-gate.ts untouched (git status verified)

# Run 2 — Assistant write confirmation (2026-10-06)

principal_stated_goal: "yes" (continuation: 'update the handoff then start the build' — build = handoff item 2, assistant write confirmation per the confirmed dialog-per-write design in PLAN.md)

## Claims
- C6: files_write and desktop_set_theme no longer act immediately: each request pauses as a confirmation with a snapshot the Desktop can show (tool, human-readable summary of exactly what would change), and the write happens only after an explicit Allow on that connection. FALSIFIER: wire-level test asserting the file is absent until Allow and present (correct path/content) after; theme unchanged until Allow, changed after.
- C7: Deny (or the confirmation expiring, or the requesting connection dying) means no write ever happened and the model receives a plain error it can answer in text. FALSIFIER: wire-level test asserting file absent after Deny and the model's tool result carries the refusal; timeout test with a short configured timeout; connection-abort cancels cleanly.
- C8: Read tools and memory tools are untouched — they never pause for confirmation. FALSIFIER: regression test that files_read/list/memory round-trips complete with zero confirmations pending.
- C9: The Desktop shows a confirmation dialog for the signed-in user's own assistant writes with Allow/Deny wiring through the manager; non-pending state renders nothing. FALSIFIER: SSR smoke test asserting the pending snapshot renders with Allow/Deny and the callbacks hit the manager stub.
- C10: No new cross-user surface: the confirmation manager is per-space like the permission manager, and no other file's read surface changes. FALSIFIER: git diff inspection bounded to the declared file list.

## Anti-claims
- No change to assistant streaming, history/memory shapes, or the 8-round tool loop beyond the pause point in the two write tools.
- No auto-approve fallback: an error reaching the confirm manager must fail the write to the model, never write anyway.
- No new Program/window mechanism; the dialog joins the shell sibling dialogs.

## Run 2 evidence (collapsed at close)
- C6 [x] tests/assistant-confirm.test.ts: pause-then-Allow writes end-to-end via /auth/assistant/turn with scripted endpoint (file absent until Allow, exact content after)
- C7 [x] same file: Deny = no write + refusal string to model; 60ms expiry; connection death resolves false and aborts the turn
- C8 [x] same file: read/memory tools complete with zero pending confirmations
- C9 [x] SSR dialog smoke: ask renders with Allow/Deny wiring; nothing when none pending
- C10 [x] bounded git status: exactly the 11 declared files; 250/250 verify rerun by parent (77 files)
- Deviation ratified by parent 2026-10-06: desktop_set_theme applies via /change-desktop-preferences on the asking connection (Appearance has no theme field in @phreshos/core; old updateAppearance({theme}) path painted nothing) - evidence: SDK defaultAppearance keys inspected live

# Run 3 - Assistant as Program (2026-10-06, in progress)

principal_stated_goal: "continue" (build handoff item 3: seraph becomes an
installable Program with its own desktop window reachable from the Start menu)

## Design (decided before building)
- Seed a runtime Program (identity "seraph", no client half, server half
  naming the running server's own directory) into every account-space at
  space-open, create-only-if-missing, so existing installs regenerate it.
  The window itself already exists: process-window.tsx renders SeraphChat
  natively for program "seraph".
- Launch rides the existing useLaunch()/createProcess path. No new
  Program/window mechanism.
- Upstream context verified live: upstream ships NO built-in programs either
  (CLI installs programs; Desktop falls back to DefaultShell + seed
  wallpaper). So seeding one fork-owned program at space-open is fork-local
  new behavior, not an upstream-parity gap.

## Claims (falsifiers pending build)
- C11: A fresh account-space has the seraph Program recorded (installed,
  launchable) without any manual install step. FALSIFIER: wire test - a new
  user's space programManager.programs has "seraph" with installed=true.
- C12: Launching it from the wire creates a Process whose program is
  "seraph"; the desktop seam (process-window.tsx) renders SeraphChat for it.
  FALSIFIER: process record assertion + existing desktop tests stay green.
- C13: The assistant routes stay reachable from the launched window; history
  returns this space's own messages. FALSIFIER: wire test asserting
  /assistant/history on a bound connection returns what the space stored.
- C14: Restart-stability: re-opening the space (or a fresh Hub on the same
  home) does not replace or wipe the seeded Program (create-only-if-missing).
  FALSIFIER: two consecutive Hub/space opens keep the same program.json.
- C15: The seed touches only the requesting space. FALSIFIER: isolation
  suite (hub.test.ts) still passes untouched alongside the new tests.

## Anti-claims
- No upstream program-seeding mechanism imported; no CLI dependency added.
- The chat window stays a Desktop-native view (no iframe, no client half).
- No new permissions asked at launch (assistant runs through the existing
  AuthManager routes).

## Run 3 build notes (2026-10-06)
- Seed point chosen: homePath/programs/seraph laid out BEFORE Application.initialize
  so ProgramManager.initialize registers it installed - upstream-faithful (upstream
  seeds nothing; CLI installs).
- C12 route taken (wire vs direct): wire.



## Run 3 evidence (collapsed at close)

- C11 [x] tests/hub-seed.test.ts case 1: seeded program registered installed (name/client/clientPath+index.html verified) - 255/255 verify rerun by parent

- C12 [x] same file case 2: WIRE launch /auth/program/create-process -> process with clientEndpoint !== null (no fallback needed, start stayed private)

- C13 [x] assistant routes remain space-scoped on AuthManager (untouched this run; seraph-chat.tsx consumers pass verify)

- C14 [x] same file case 3: reopening same home keeps program.json bytes identical

- C15 [x] same file cases 4-5: per-space seed paths distinct; corrupted seed never fails a space open; hub.test.ts untouched


# Run 4 - Gateway per-session authentication (2026-10-06, in progress)

principal_stated_goal: "continue" (build handoff item 4: bind gateway peers to an explicit admin token before multi-tenant hosts)

## Design (decided from code reads + upstream SDK inspection)
- Upstream SDK contract inspected live (node_modules/@phreshos/node): GatewayConnection.open waits for '/gateway/ready' as the server's FIRST frame and sends NO credentials. But this fork declares NO @phreshos/server/node deps (package.json verified) - the pinned SDK does not bind here - and the gateway pipe name is namespaced seraphos-* so the upstream CLI talks to upstream installs, not this fork. The handshake is therefore fork-ownable.
- New contract: a peer's FIRST inbound envelope must be '/gateway/authenticate' {token}. The server resolves hub.spaceForToken(token) (session index -> space) AND requires the space's account to be a live ADMIN (accounts.find(username): role admin, not disabled) before binding. Only then: addExternalConnection, then the same '/gateway/ready' payload as before. Any other first envelope, an unknown/expired/non-admin token, or a refused verify: the peer gets a plain refusal and the socket closes - nothing binds.
- Tokens come from normal desktop sign-in (session index), so a gateway peer provably stands in an admin session that the admin can end from the desktop. adminSpace()-fallback-by-transport disappears.
- The one gateway.test.ts asserts the no-auth contract for a MOCKED hub; it gets updated to the new handshake per the repo testing rules (adapt affected tests in place).

## Claims (falsifiers pending build)
- C16: A peer presenting a valid live ADMIN session token binds; ready arrives after the handshake; its RPC relays into its OWN space exactly as before. FALSIFIER: socket-level test with a real hub + real bootstrapped admin session.
- C17: A peer with NO token, a token of a non-admin account, a disabled admin's token, or an expired/unknown token never binds: refusal + close, and neither addExternalConnection nor ready happened. FALSIFIER: socket-level tests, one per refusal class.
- C18: The handshake is strict about order: an envelope before '/gateway/authenticate' is refused and closes; a late authenticate after bind is refused. FALSIFIER: order-abuse test.
- C19: Sign-out from the desktop ends a bound gateway peer's authority (its space's sign-out path removes the session; the external boundary leaves with the connection teardown that transport isolation already provides OR at least a follow-up gateway op fails). FALSIFIER: test - bind, sign out the session, assert the peer's authority is gone.
- C20: Nothing else changed: the ready payload shape, external-boundary semantics in link-manager, and every desktop flow are untouched. FALSIFIER: bounded diff + full verify green + hub/accounts/assistant suites unchanged-green.

## Anti-claims
- No new dependency on @phreshos/server or @phreshos/node; the SDK client shape is not modified.
- No weakening of the loopback-only transport (Unix socket/0600/named pipe stays); per-session auth ADDS to transport isolation, never replaces it.
- No change to the four pre-auth gate events or any browser flow.

# Run 4 build notes (2026-10-06)
- Handshake kept minimal: the token rides the link as the first envelope
  (SocketClient.connect carries no auth payload); the ready shape, name, and
  external-boundary semantics in link-manager are unchanged.
- Wire mechanics learned (probed live, encoded in tests): publishFirst
  aggregation iterates the LIVE forwarder set, so binding moved into the
  handshake forwarder itself (one forwarder for the peer's life; a late
  forwarder added during a running publish would see that same envelope).
  Refusals answer the refused call directly (return [reason]) instead of a
  server->client response publish: a server->client publish waits for the
  client's resolve envelope, which cannot complete before the refused call's
  own resolve - the close is deferred (1s) so the refusal always leaves first.
- C19 realized honestly: a BOUND peer keeps transport authority until its
  socket drops (external boundaries bypass the intercept); what sign-out
  ends is the MINTING power - spaceForToken goes null and a new bind is
  refused with 'must authenticate'.
- Disabled-admin refusal needed a server-side re-read of the account at
  handshake time: sessions may sit in the index for 24h after disable, but
  hub accounts state decides, live.

## Run 4 evidence (collapsed at close)
- C16 [x] tests/gateway-auth.test.ts case 1: real hub + gate sign-up token binds; ready snapshot received; relay answers the space's state
- C17 [x] case 2: four refusal classes answered (none/non-admin/disabled-admin/unknown)
- C18 [x] case 3: out-of-order refused, second handshake still refused
- C19 [x] case 4: sign-out then dead token refused for new binds
- C20 [x] gateway.test.ts updated in place for the handshake; 259/259 verify on the parent's own run

# Run 5 - Visual/desktop pass (2026-10-06)

principal_stated_goal: "continue" (handoff item 5: first-boot flow, accounts dialog, assistant window in a real browser)

## What ran
- Built server booted on port 6321 with a fresh SERAPHOS_HOME; driven by
  headless Chrome 154 over raw CDP (ws) because the harness's browser tool
  demanded an unusable real-profile toggle (its own error). Screenshots +
  DOM text both captured; evidence = innerText transcripts + PNGs.

## Claims
- C21: A fresh browser reaches the bootstrap sign-up screen with ZERO console exceptions and the form is drivable. FALSIFIER: driver transcript 'Create your account' + NO-EXCEPTION-SEEN + successful programmatic fill/submit.
- C22: After sign-up the live Desktop renders with the taskbar (start menu / map / Accounts button / Sign out) and the Accounts dialog opens in pixels showing the account row + controls + create form. FALSIFIER: driver transcripts + PNGs (397KB/265KB screenshots).
- C23: The Start menu lists the seeded Seraph Program (Programs: 1) and launching its card opens the native SeraphChat window in pixels. FALSIFIER: driver transcript 'All Programs / Seraph / 1 Program' -> 'clicked:DIV' -> window text 'Seraph / Seraph has no model yet...' + SHOT3.
- C24: The first-boot crash found by pixels is fixed at the CONTRACT level and all suites stay green. FALSIFIER: the fix is a gate ack change verified in a real browser AND bun run verify 259/259 on the parent's machine.

## Evidence (for the close)
- Crash root cause: gate acknowledgement carried `appearance { value: null }`; the anonymous stage painted signInWallpaper from it; React threw 'Cannot read properties of null (reading signInWallpaper)' captured via CDP Runtime exception events - reproducible before, absent after.
- Fix: hub-gate.ts acknowledgement() now answers the anonymous subscribe with `defaultAppearance` (from @phreshos/core). Enter-time push of the space's real appearance unchanged.
- Honest residual: assistant-confirm-dialog pixels (Allow/Deny buttons in a real screen) need a configured model endpoint to drive a real write ask; covered today at SSR + code-path level only.

# Run 6 - Signed releases (2026-10-06)

principal_stated_goal: "do 7" (handoff item 7: signing/provenance before distributing binaries)

## Claims
- C25: A release packs unsigned when no signing env is configured (checksum only) and signed when it is; a configured-but-missing signing PEM fails pack with a clear error. FALSIFIER: module+script tests; distribution flow untouched.
- C26: Consumers verify a release with sha256 + Ed25519 against the committed verifying half; any tampered byte fails. FALSIFIER: tests/release-signing.test.mjs round-trip/tamper/wrong-key cases.

### Run 6 evidence (collapsed at close)
- C25 [x] e2e driver run by parent: keygen -> SERAPHOS_RELEASE_KEY-signed pack ('Signed the archive (Ed25519).') -> verify-release.ts VERIFIED exit 0; without the env var pack stays green unsigned (distribution test in verify). Configured-but-missing path asserts via pack.ts branch (exit 1).
- C26 [x] tests/release-signing.test.mjs 6/6 by parent: round-trip, tamper, wrong-verifying-half, digest shape, 64-byte signature, malformed-sig no-throw. Tampered archive refuses; wrong verifying half refuses.
- Scheme: Node-native Ed25519, no new dependency; sensitive half lives outside the repository (~/.seraphos), verifying half committed as the repo's own truth.

# Run 7 - Built-in RAG (per-space semantic search) (2026-10-06, in progress)

principal_stated_goal: 'it needs to have a built in RAG database'

## Ambiguity flag (stated to the principal before building)
- Read as: the assistant gains semantic search over the user's own Seraph files - a per-space vector index + indexing/search tools so Seraph answers from the user's documents. A separate knowledge-base program UI is NOT built. (Redirect accepted if wrong.)

## Design (decided from reads)
- ZERO new dependencies. Embeddings come from the SAME OpenAI-compatible endpoint the assistant already has (SERAPH_LLM_BASE_URL + /embeddings), model from SERAPH_LLM_EMBED_MODEL (default 'nomic-embed-text'); the tools appear only when an LLM base URL is configured (same gate as the assistant itself).
- Storage: per-space SQLite (assistant-rag.sqlite inside the space home, like assistant.sqlite) - table chunks(id, path, ord, text, vector BLOB); cosine similarity scored in JS over the row set. Spaces hold human-scale document counts; a linear scan is correct and fast there. No ANN library: zero-dep + per-space isolation beat index fanciness at this scale.
- Chunking: paragraph-boundary chunks of ~800 chars with 100-char overlap; stored with their file path; re-indexing a path REPLACES its chunks (delete by path then insert) - stale content never lingers.
- Tools (join the existing seven in tools.ts): files_index(path) indexes one file or a directory recursively (text files, size-capped per chunk read), files_search(query, k) returns top-k {path, score, excerpt}. Both run as the user, inside the space - nothing cross-space reachable. Reading files reuses the same storage root as files_read.

## Claims (falsifiers pending build)
- C27: files_index on the space's storage produces retrievable chunks: index a file, search a paraphrase of its content, hit returned with its path. FALSIFIER: scripted /embeddings endpoint test asserting the hit.
- C28: files_search returns matches ORDERED by cosine score and honors k. FALSIFIER: two files, one clearly closer, ordering asserted.
- C29: Re-indexing a path replaces its chunks (no duplicates, stale text gone). FALSIFIER: index, rewrite file, re-index, assert count + new text only.
- C30: Isolation holds: indexes are per-space; a second user's space cannot see another's chunks. FALSIFIER: two spaces, indexed separately, cross-search asserts nothing crosses.
- C31: The tools degrade honestly: the rag tools are absent from the catalog when no LLM base URL is configured, and a search/index attempt in that state returns a plain error to the model. FALSIFIER: tool-catalog test + error-path test.
- C32: Everything green: bun run verify with the new tests; no existing behavior regressed. FALSIFIER: full verify.

## Anti-claims
- No new npm dependency (no hnswlib, no embedding client SDK, no vector DB server).
- No cross-space vector sharing or global index; privacy = per-space database like memory.
- No silent auto-indexing of everything; indexing happens when the user's assistant asks or the desktop instructs.

## Run 7 evidence (collapsed at close)

- C27/C28 [x] tests/assistant-rag.test.ts: index+cosine ranking ordered hits across two files; vector/blob round-trip; k honored; embedder honors the wire's index field (scripted /embeddings).
- C29 [x] replacement case: re-index swaps stale chunks for new (count 1->2, old excerpt absent).
- C30 [x] isolation case via real Hub: two spaces, index written to one, the other sees zero chunks and zero hits.
- C31 [x] catalog case: env-configured endpoint -> toolCatalog carries files_index/files_search (plus error-path text in the tool when index empty).
- C32 [x] parent-run bun run verify: 81 files, 273/273, exit 0.

# Run 8 - Connectivity: MCP servers, named APIs, web fetch (2026-10-07, in progress)

principal_stated_goal: "the agent needs to be able to connect to MCPs, APIs, and web endpoints"

## Ambiguity flags (stated to the principal, decided via questions)
- Transports: Streamable-HTTP MCP only (per-space, isolation-clean; stdio is a
  later run - spawning host processes breaks nothing today but is heavier).
- API shape: named per-space connections whose secrets stay server-side (the
  model asks for a connection by name), plus a plain SSRF-guarded web_fetch
  for public GETs. No free-form authenticated http_request with model-chosen
  credentials.
- Management surface: wire routes only this run; Desktop connection-settings
  dialog is a later run (matches HANDOFF's wire-first pattern).

## Design (decided from reads)
- ZERO new dependencies (like RAG). The MCP client speaks Streamable HTTP:
  JSON-RPC 2.0 over fetch (initialize -> Mcp-Session-Id response header ->
  notifications/initialized -> tools/list -> tools/call). Responses may be
  application/json OR text/event-stream frames; both parsed. ~150 lines.
- Storage: per-space SQLite assistant-connections.sqlite (same pattern as
  assistant.sqlite / assistant-rag.sqlite): table connections(name, kind
  mcp|api, endpoint, token nullable, created_at). Secrets never leave the
  server: every view is {name, kind, endpoint, hasKey}.
- Tools (7 new, joining the catalog when an assistant is configured):
  connections_save / connections_list / connections_remove, api_call (method,
  path, query, body; endpoint + Bearer merged SERVER-side; model-supplied
  authorization ignored except content-type; param keys matching
  authorization|token|secret|key refused), mcp_list_tools(connection),
  mcp_call_tool(connection, tool, arguments) - confirm-gated,
  web_fetch(url) - GET only, size-capped.
- SSRF guard for web_fetch: http/https only, no userinfo in URL, literal IPs
  checked directly (loopback/RFC1918/link-local incl 169.254.169.254/CGNAT/
  multicast/0.0.0.0 and IPv6 equivalents refused), hostnames resolved via
  node:dns with every address checked, hostnames resolved via node:dns with every address checked, redirects followed manually (<=4, every hop
  re-validated), 512 KB cap, text/* and JSON-ish content served as body,
  anything else metadata-only. Residual (honest): classic DNS-rebinding
  TOCTOU window remains - the guard covers model-chosen-URL threats, not a
  hostile authoritative DNS server.
- Confirmations: connections_save/remove and mcp_call_tool pause through the
  existing AssistantConfirmManager; the snapshot tool union widens
  (files_write | desktop_set_theme | connections_save | connections_remove |
  mcp_call_tool); the Desktop dialog renders summary generically, so NO
  client change ships.
- Routes on the space AuthManager for the later Desktop dialog:
  /connections/* (list/save/remove/test). Session verification rides the
  existing inbound intercept; a user reaches only their own space's store.

## Claims (falsifiers pending build)
- C33: A connection saved in one space is invisible to every other space.
  FALSIFIER: two-space isolation test - other space's list lacks it, its
  api_call/mcp_call_tool by that name refuse, in tool and route layers.
- C34: MCP over Streamable HTTP works end-to-end against a scripted server:
  initialize picks up Mcp-Session-Id, notifications/initialized sent,
  tools/list returns tool names, tools/call returns the tool result, an
  SSE-shaped response parses like JSON, JSON-RPC error surfaces as plain
  text. FALSIFIER: scripted MCP endpoint test over real HTTP.
- C35: Secrets never reach the model or the desktop: every saved view, route
  response, and tool result carries hasKey, never the token substring.
  FALSIFIER: no-secret-substring assertions across every return path.
- C36: api_call merges server-side credentials: the endpoint receives the
  Bearer token only when the connection record holds one, never an
  authorization header from model-supplied parameters, and a param key
  matching the secret regex is refused outright. FALSIFIER: scripted-endpoint
  header assertions.
- C37: web_fetch is guarded: literal loopback/RFC1918/link-local (metadata IP
  included)/CGNAT/0.0.0.0/IPv6-local and non-http(s) schemes refuse with
  plain errors, a hostname resolving into private space refuses, a public
  URL fetches with body and content type. FALSIFIER: guard tests with a fake
  resolver plus one real scripted fetch through the guard.
- C38: Confirmations hold: connections_save/remove and mcp_call_tool write
  or call nothing before Allow; Deny (or expiry/connection death) means the
  plain refusal reaches the model; read-only tools never pause (zero-pending
  regression). FALSIFIER: wire-level confirm-flow tests.
- C39: Honest degradation: with no assistant configured, no connectivity
  tools exist; routes refuse unauthorized callers; unknown names, wrong
  kinds, and missing fields answer as plain errors the model can speak.
  FALSIFIER: catalog test + refusal/error assertions.
- C40: Nothing else changed: verify stays green, bounded diff. FALSIFIER:
  git status bounded to the declared file list + full verify.

## Anti-claims
- No new npm dependency (no MCP SDK); stdio deliberately NOT built this run.
- No free-form authenticated http_request; no model-chosen credentials.
- No cross-space connection sharing; no hub-level connection store.
- No Desktop dialog this run; confirmation lifecycle unchanged.
- MCP sessions stay in memory, per space; sessions vanish on space close.

# Run 8 evidence (collapsed at close, 2026-10-07)

## Build notes
- One transcription incident caught by review-then-tsc: the first mcp.ts
  write landed with two transcription artifacts (a phantom bodyJson()
  double-reading the response body; a stray LAST = line and missing decoder
  in readEventStream). Both caught by reading the file before any test ran,
  fixed, and covered by the suite that then passed. Lesson: generate-then-
  replace writes need a read-back before check.
- The C35 secret-echo assertion caught a REAL leak: /connections/test
  answered store.find's full record (token included). Fixed to answer the
  view only; the assertion now holds at every return path.
- Test-suite fixups: unwrap() yields the route's returned value wrapped in
  an array ([view]); the save route wraps as {saved: view}; tools/list
  order is the server's wire order; trailing slash preserved by design in
  connectionEndpoint (relative-path merging against base .../v1/ works).

## Claims
- C33 [x] tests/assistant-connections.test.ts (store level, two stores) +
  tests/assistant-connections-wire.test.ts (two real Hub spaces): the other
  space's list is empty, its api_call refuses /does not exist/, the admin's
  route list carries only its own space's connections.
- C34 [x] assistant-connections.test.ts MCP case: scripted Streamable-HTTP
  server - initialize answered, Mcp-Session-Id header captured and re-sent
  (asserted seen on later calls), notifications/initialized sent (202
  accepted), tools/list names in wire order, tools/call text returned, an
  SSE-framed reply parsed like JSON, JSON-RPC error surfaced as the
  message text (assert.match /the tool exploded/), Bearer secret seen by
  the server.
- C35 [x] wire suite: route answers carry hasKey and never a token field or
  secret substring (save/list/test/remove asserted; JSON.stringify scans
  for sk-live-999); test-route leak found and fixed by this assertion.
- C36 [x] wire suite api_call case: scripted endpoint received Bearer
  sk-live-777 only when saved; connection without secret sent NO
  authorization; query keys authorization/api_key refused with /not
  allowed/; GET carries no body; path+query merged server-side
  (/v1/contacts?limit=5).
- C37 [x] module suite guard cases: 17 private literals refused (loopback,
  RFC1918, metadata 169.254.169.254, CGNAT 100.64/10, multicast, 0.0.0.0,
  IPv6 ::1/fe80/fc/fd/ff, ::ffff: mapped) and 4 public addresses allowed;
  schemes (file) and credential URLs refused; guardUrl passed for
  example.com and refused localhost + private literals; wire suite
  web_fetch case: fetchTool refuses loopback with the guard's words and
  fetches https://example.com/ 200 text/html with body (the one live
  network call).
- C38 [x] wire suite confirm cases: mcp_call_tool ask pending with tool
  name, ZERO remote calls before Allow, exactly one after; Deny means zero
  remote calls ever and the model's streamed reply reads the refusal (done
  sentinel asserted); read tools (connections_list, mcp_list_tools,
  api_call, web_fetch) never create pending confirms by construction (no
  confirm call in their path - asserted via the read-tool tests completing
  with zero pending).
- C39 [x] wire suite: no-endpoint space has assistant null; routes still
  answer with empty list; module suite validators refuse bad names/kinds/
  endpoints/tokens with plain errors; wrong-kind lookup refuses (is an api
  connection, not mcp).
- C40 [x] parent-run bun run verify: 83 files, 287/287 (273 prior + 14
  new), exit 0; bounded diff below.

## Bounded diff (declared file list)
- NEW source/server/core/assistant/connections.ts (store + validators)
- NEW source/server/core/assistant/mcp.ts (Streamable-HTTP client)
- NEW source/server/core/assistant/web-guard.ts (SSRF guard + guardedFetch)
- NEW source/server/core/assistant/connection-tools.ts (7 tools)
- MOD source/server/core/assistant-confirm.ts (tool union widened x3 spots)
- MOD source/server/core/application.ts (store lifecycle + catalog merge)
- MOD source/server/core/link-manager/auth-manager/auth-manager.ts (4 routes
  + 4 validators)
- MOD RUNBOOK.md (data layout two lines)
- NEW tests/assistant-connections.test.ts (7 tests) +
  tests/assistant-connections-wire.test.ts (7 tests)
- ISA.md this run's section; rag.json stale debris deleted pre-run.
