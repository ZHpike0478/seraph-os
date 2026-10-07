# Seraph OS — Engineering Hand-off

Date: 2026-10-06. Built by steph with Perplexity Computer (Hermes agent).

## What this repository is

Seraph OS is a multi-user web desktop: a Node server that hosts each user's
programs, file storage, and an AI assistant, and a browser Desktop each user
signs into individually. One repo contains the whole System:

- `source/server` — the authoritative runtime ("the System")
- `source/client` — the React Desktop the browser loads
- `source/shared`, `source/libs` — cross-cutting contracts and utilities
- `tests/` — 82 files, behavioral and boundary-focused

**Provenance.** Fork of [PhreshOS/system](https://github.com/PhreshOS/system)
at release 0.1.117 (commit `b9c6185`, MIT, © 2026 Zohayr SLILEH). The fork
kept upstream's MIT license with dual copyright in `LICENSE`, attribution in
`README.md`, and — deliberately — the upstream SDK contract internals:
`__PHRESHOS_SERVER_TRANSPORT__`, `__phreshos*` sandbox transport calls, and
the `@phreshos/core` + `@phreshos/react-ui` published dependencies. Do not
rename those; program SDKs speak that exact wire.

## Verified state (as handed off)

- `bun run verify` green (`bun run verify` equivalent): type-check, build,
  pack, **286/286 tests** across 82 files, including a distribution test
  that packs the release, installs it to a temp folder, and boots it
  (`tests/distribution.test.mjs`).
- Twenty-one commits, clean tree, pushed to
  [ZHpike0478/seraph-os](https://github.com/ZHpike0478/seraph-os) `main`.
  History starts at `991c231` (pre-rebrand snapshot) so the upstream diff is
  always reviewable. Latest commits: `219fc46` (assistant retrieval upgrade,
  item 8 below) on top of `2202e4d` (built-in RAG) and `ae0ac1e` (signed
  releases, item 7).
- Live-wire verification: real messagepack WebSocket clients drove `/link`
  end-to-end (subscribe ack → anonymous owner state → bootstrap sign-up →
  session token push → second-connection sign-in → bound RPC) against the
  built server on port 6499. A headless-Chrome visual pass (item 5) covered
  bootstrap, sign-in, Desktop, Accounts dialog, and the SeraphChat window;
  full chat/dialog pixels with a configured model remain the one pixel-check
  TODO.

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
  **built-in hybrid retrieval** (2026-10-06, commit `219fc46`). Each space
  keeps `assistant-rag.sqlite`. Two coordinated stores: `chunks` (path, ord,
  text, Float32 vector blob, plus lineage columns `size`, `modified_at`,
  `indexed_at`) and `chunks_fts`, an **external-content FTS5 mirror** of
  chunk text kept in sync by insert/delete/update triggers (the FTS5
  `'delete'` command form is only legal against external-content tables —
  do not revert to a plain fts5 table or deletes fail with "SQL logic
  error"). Search is hybrid: cosine over vectors and BM25 over the mirror,
  fused by reciprocal rank with the keyword leg weighted higher (0.6 vs
  0.4) — an exact identifier (`6300`, `ragIndex`, an error code) outranks a
  distant paraphrase. A noise `floor` (0.3, applied in `rag-tools.ts`)
  drops cosine-only fuzz but **keyword matches always stand**. Hits carry
  `ord`, raw `cosine`, `matched`, full chunk text, and the lineage triple,
  so a caller can tell stale from fresh. `cosine()` returns 0 on
  dimension mismatch instead of NaN.
- Index lifecycle: `RagIndex.adoptModel()` stamps the embedding model in a
  `meta` table; the FIRST call stamps it, a model CHANGE resets every chunk
  in one transaction, and `files_search` then refuses until `files_index`
  reindexes — vectors from one model carry no meaning in another's
  geometry. A `ftsVersion` stamp rebuilds the mirror once when a database
  from an older layout opens. v0 databases (no lineage columns) migrate in
  place via `pragma table_info`.
- Ingestion (`rag-tools.ts`): extension **allowlist**
  (`INDEXABLE_EXTENSIONS` — code, docs, configs, data, and `.pdf`), a
  replacement-character (**U+FFFD > 1%**) binary detector, per-file error
  isolation (a vanished or unreadable file is skipped and reported, never
  aborts the run), a 512 KB per-file cap for text (16 MB for PDFs, which
  parse wholly in memory), and a
  `skipped: [{path, reason}]` report in `files_index`'s result. **PDF
  ingestion (2026-10-06, `source/server/core/assistant/pdf.ts`)**: PDFs
  are never read as text — bytes stream through a binary-safe reader into
  `unpdf` (Mozilla PDF.js serverless build, lazy-loaded on first PDF so
  the boot path never touches the ~1 MB parser bundle). The extractor
  validates the `%PDF-` header (junk wearing the extension is a clean
  skip, not a crash), then extracts per page (`mergePages: false`): each
  page becomes ONE chunk titled `path (page N)` for the embedder while
  stored text stays clean, text-free pages take no chunk, and a
  `no extractable text (N pages)` skip covers image-only PDFs. Page
  numbers ride the chunks table (`page` column, default 0 for text
  chunks, migrated in place via `pragma table_info` like the lineage
  columns) and come back on every hit as `RagHit.page` — a citation can
  name file and page. Parser failures (truncated, password-locked,
  structurally broken) skip the file with the parser's message. Chunks
  are ~800-char paragraphs with 100-char overlap, embedded **with their
  file path prefixed** (`notes/todo.md\n...`) so paragraphs of different
  files stop sounding identical; embedding requests ride in batches of 32.
  Embeddings still come from the SAME OpenAI-compatible endpoint
  (`SERAPH_LLM_EMBED_MODEL`, default `nomic-embed-text`); the retrieval
  tools are absent when no endpoint is configured. KNOWN TRAP:
  `FileArea.list()` returns paths **relative to the listed directory** —
  `collect()` must join them back onto the path it recursed from, or
  nested files index under phantom names (this was a live bug).
- Memory + auto-recall: `memory_remember` dedupes — a proposed fact
  with ≥0.6 Jaccard word-overlap against an existing fact **replaces**
  that fact's text and keeps its identity, so rephrasings cannot
  accumulate. `Assistant.turn()` recalls memory itself: the top 6 fact
  matches for the user's message ride into the system prompt as a
  `Saved facts:` line — recall no longer depends on the model choosing to
  call `memory_recall`. `files_write` drops the written path's stale
  chunks so search cannot serve text the assistant just replaced.
- Eval harness: `tests/assistant-retrieval.test.ts` — corpus recall with
  deterministic hash embeddings, keyword-leg-carries-identifier,
  floor semantics, model-reset, dimension-mismatch, ingestion skip
  reporting, a **verbatim-quote property** (any six consecutive words
  of any chunk must return that chunk first, via the keyword leg), and
  **real-PDF ingestion coverage** (a hand-rolled valid-PDF builder with
  true xref offsets — page lineage, blank-page omission, excerpt
  cleanliness, junk/truncated/image-only skips with reasons). Extend
  this file, not ad-hoc tests, when touching retrieval.
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
`AssistantMemory.close`, `RagIndex.close`) before `rm`ing a home dir;
temp-dir cleanup is best-effort (`maxRetries: 10, retryDelay: 100`, wrapped
in try) because Windows holds fresh handles; `parsePorts` test-cases must
be re-derived after any port-range rename (a bad rename once produced a
"valid" range). Vitest's fork pool swallows test-process stdout: assert on
results, don't log-and-look — write diagnostics to a file if you must see
them.

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

8. DONE (2026-10-06, commit `219fc46`) — Assistant retrieval upgrade, the
   full list is in the assistant section above. In one line each: hybrid
   FTS5+cosine search with reciprocal-rank fusion; staleness lineage
   (size/modified/indexed per chunk) with search results exposing it;
   `adoptModel` geometry stamp that resets chunks on an embedding-model
   change; ingestion allowlist + binary detector + skipped-file reporting +
   batched embeddings; a fixed `collect()` bug that dropped nested files;
   Jaccard-dedup on `memory_remember`; auto-recall of saved facts into
   every turn; `files_write` dropping stale chunks; and an eval harness
   with a verbatim-quote property test. The retrieval layer now has the
   property test a future refactor must keep green — extend
   `tests/assistant-retrieval.test.ts` rather than bypassing it.

9. DONE (2026-10-06) — PDF ingestion into the RAG index. A client can now
   point `files_index` at a directory of mixed files and PDFs are parsed,
   not skipped: new `source/server/core/assistant/pdf.ts` (unpdf/PDF.js,
   lazy-loaded, header validation, per-page extraction, 500-page and 16 MB
   caps), a `.pdf` allowlist entry, per-page chunks titled `path (page N)`
   with a `page` lineage column on chunks (migrated in place) surfaced as
   `RagHit.page`, and skip reasons for junk/truncated/image-only PDFs.
   Tests 286/286. Dependency note: `pdf-parse` was rejected (unmaintained,
   malicious-publish history); `unpdf@^1.8.1` is MIT, zero-dependency, and
   its bundled PDF.js chunk ships inside the vite build with no external
   wiring.

## Environment (all optional; System runs without any)

`SERAPHOS_HOME` (state root), `SERAPHOS_PORT` (list/ranges), `SERAPHOS_HOST`
(bind interface), `SERAPH_LLM_BASE_URL`, `SERAPH_LLM_API_KEY`,
`SERAPH_LLM_MODEL`, `SERAPH_LLM_EMBED_MODEL` (the retrieval geometry its
index stamps; changing it resets that space's chunks).