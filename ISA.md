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
