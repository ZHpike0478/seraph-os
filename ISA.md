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
