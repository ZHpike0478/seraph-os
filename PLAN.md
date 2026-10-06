# Seraph OS — Build Plan

Fork of PhreshOS/system @0.1.117 (MIT, © Zohayr SLILEH), rebranded as Seraph OS
(0.2.0). Original MIT license and attribution preserved in LICENSE and README.

## Phase 1 — Fork, rebrand, boot (complete)

- Fresh git history: "Seraph OS: fork of PhreshOS/system (MIT) at 0.1.117, pre-rebrand snapshot"
- Display name, package name (`seraphos`), env vars (SERAPHOS_HOME/HOST/PORT),
  ports: dev 6300s, installed 6400s; home `~/.seraphos`
- Preserved pinned SDK internals: `__PHRESHOS_SERVER_TRANSPORT__`,
  `__phreshos*` sandbox transport calls, and the `@phreshos/core` +
  `@phreshos/react-ui` published SDK dependencies (MIT)
- Verified at base: bun install + build + 220/220 tests green on PhreshOS
  0.1.117 before rebrand; rebrand verification runs after this commit

## Phase 2 — Multi-user kernel (in progress)

Build order (isolation before sign-in cutover, so no intermediate state leaks
one user's data to another):

1. DONE — `source/server/core/accounts.ts`: SQLite account store, admin/user
   roles, last-admin demotion/disable lockout, scrypt credentials compatible
   with the owner record shape, `verify` returning username + role
   (tests/accounts.test.ts, 7 tests)
2. Sessions carry `user`; `Authentication.open` migrates the owner record into
   an admin account on first open; verify/sign-in resolve through Accounts
3. DONE — isolation achieved structurally: one Application (space) per account under Hub; Gate door (ink) routes every browser socket; per-space storage, programs, processes, sessions. No cross-user path exists.
   is 3.7k lines; this is the big retrofit — every announce* gains a user scope)
4. DONE — spaces keep their own storage root (`home/users/<name>/`), System-storage native root inside the space, uploads per space; doors resolve the caller token to its space.
   appearance + uploads + desktop-file per user
5. DONE — Gate handles owner state/sign-up/sign-in/session-authenticate; bootstrap admin on first visit; live wire probes passed (subscribe ack, anon state, sign-up+token push, second-connection sign-in, bound RPC). Client cutover verified over the real wire (messagepack ws).
   binding everywhere the Desktop reads state; bootstrap admin prompt on first
   Desktop visit; admin account management routes (`/accounts/*`, admin-only) — DONE
6. Gateway authenticates as administrator

Design decisions (confirmed by the owner):

- Admin-managed accounts; each user gets a private desktop, private programs,
  private storage, per-user sessions
- Per-user persistence: `home/users/<user>/` — programs, file areas (data and
  cache per program), assistant memory, preferences; SQLite-backed
- Sessions carry the user identity; connections, processes, windows,
  announcements, appearance, and uploads all become user-scoped
- Announcement isolation: connection/process/permission events filtered to the
  owning user's connections
- Gateway (CLI/agent boundary) authenticates as administrator; first boot
  creates the administrator account on the first Desktop visit
- Admin manages accounts (create, disable, reset) through the Desktop or CLI
- Password hashing keeps scrypt parameters; the users table replaces the owner
  file; sessions keep SHA-256 token hashing and the 24h disconnected lifetime

## Phase 3 — Seraph assistant

- Built-in chat Program (client) + assistant service (server side), streaming
- OpenAI-compatible endpoint: SERAPH_LLM_BASE_URL / SERAPH_LLM_API_KEY /
  SERAPH_LLM_MODEL
- Tool-calling as the user, least privilege: open/close programs, read/write
  the user's files, set theme/wallpaper, save/recall long-term memory
- Per-user conversation history and long-term memory in the user's SQLite
- Read tools run freely; write tools confirm in the Desktop before acting

## Phase 4 — Hardening and docs

- Security headers on every HTTP door: CSP, X-Content-Type-Options,
  X-Frame-Options/frame-ancestors
- Origin/Host allowlist: DNS-rebinding and CSRF mitigation for plain HTTP
- TLS termination runbook (Caddy/nginx), including the /link WebSocket
- RUNBOOK.md: service install, env vars, proxy, admin guide

## Testing rules

- Adapt affected tests in place; add multi-user boundary tests
  (cross-user isolation of sessions, storage, announcements) as new files
- `bun run verify` must stay green on every phase boundary