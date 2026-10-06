# Seraph OS — Operations Runbook

## Run from source (development)

You need [Bun](https://bun.sh) 1.3 and Node.js 24.15+.

```sh
cd system
bun install --frozen-lockfile
bun run dev
```

The Desktop serves on the first free port from **6300**; state lives in
`storage/` inside the repository.

## Run as a service (production layout)

```sh
npm install --global @phreshos/cli   # the installer CLI is shared upstream for now
phresh system install
```

An installed System keeps its state in `~/.seraphos` and serves on the first
free port from **6400**. The service runs as your operating-system user:
systemd (user unit) on Linux, launchd on macOS, a scheduled task on Windows.
On a headless server, enable lingering so the service survives logout:

```sh
sudo loginctl enable-linger $USER
```

### Environment

| Variable | Does | Default |
| --- | --- | --- |
| `SERAPHOS_HOME` | State root (accounts, per-user spaces, session index) | `~/.seraphos` |
| `SERAPHOS_PORT` | Comma-separated ports or ranges to try | dev 6300–6399, installed 6400–6499 |
| `SERAPHOS_HOST` | Interface to bind | `localhost` |
| `SERAPH_LLM_BASE_URL` | OpenAI-compatible endpoint for the assistant | none (assistant off) |
| `SERAPH_LLM_API_KEY` | Bearer key for that endpoint | none |
| `SERAPH_LLM_MODEL` | Model name | `llama3.2` |
| `SERAPH_LLM_EMBED_MODEL` | Embeddings model for the user's file-search RAG tools (same endpoint) | `nomic-embed-text` |

Works with any OpenAI-compatible server: Ollama (`http://localhost:11434/v1`),
vLLM, NVIDIA NIM (`https://integrate.api.nvidia.com/v1`), OpenRouter.

On Linux, give the installed service environment with a drop-in:

```sh
mkdir -p ~/.config/systemd/user/phreshos.service.d
printf '[Service]\nEnvironment=SERAPH_LLM_BASE_URL=http://localhost:11434/v1\n' \
    > ~/.config/systemd/user/phreshos.service.d/llm.conf
systemctl --user daemon-reload
systemctl --user restart phreshos.service
```

## Multi-user model

- The **first visit** to the Desktop creates the administrator (bootstrap is
  refused once any administrator exists).
- The administrator creates further accounts from the account store
  (`accounts.sqlite`); users sign in individually.
- Each account gets one **space**: `SERAPHOS_HOME/users/<name>/` holds its own
  programs, processes, file storage (`data`/`cache` per program), uploads,
  appearance, and Seraph assistant memory (`assistant.sqlite`) — all outside
  every other space's reach.
- Sessions belong to one space; after 24 h disconnected they expire. A
  browser keeps its session token in localStorage; "sign out" ends it there,
  "sign out all sessions" ends every session of that space's owner.

## Assistant

Seraph reads its model from the environment at boot. Without
`SERAPH_LLM_BASE_URL` the chat window explains what to set. Tools available
to the model run **as the signed-in user, inside that user's space**:
list/read/write that user's files, list its programs, set its theme,
remember/recall long-term facts.

## TLS and exposure

The System speaks plain HTTP and WebSocket. For anything beyond a trusted
LAN, terminate TLS in front (Caddy shown; nginx needs explicit WebSocket
upgrade headers):

```
seraph.example.com {
    reverse_proxy 127.0.0.1:6400
}
```

Keep `SERAPHOS_HOST` on the loopback interface and let the proxy own the
public address; the System's own header wall (CSP, nosniff, frame-ancestors
'self', no-referrer) applies at every door.

## Data layout

```
$SERAPHOS_HOME/
  accounts.sqlite          every account, scrypt-hashed, roles
  sessions-index.sqlite    token hash -> account-space (routing only)
  desktop                  the served address, for local tools
  users/<name>/
    storage/               Keyv state, uploads, appearance, logs
    assistant.sqlite       conversation history + long-term facts
    system/                that user's System-storage root (file tools)
    programs/              that user's installed programs
```

## Development commands

| Command | Does |
| --- | --- |
| `bun run verify` | Type-check, build, and test — the gate every change passes |
| `bun run pack` | Build the release zip + sha256 |

## Signed releases

Releases are Ed25519-signed: `bun run pack` writes `seraphos@<version>.zip`
+ `seraphos@<version>.zip.sha256` as before, and — once a signing key is
configured — `<archive>.ed25519.sig` beside them.

Mint the key pair once (the private half lands in `~/.seraphos`; the
public half is committed as `scripts/release-public.pem`):

```sh
bunx vite-node scripts/release-keygen.ts
```

Point the pack at the signing half when cutting a release:

```sh
SERAPHOS_RELEASE_KEY=~/.seraphos/release-privatekey.pem bunx vite-node scripts/pack.ts
```

Without that variable the release packs unsigned (checksum only); a
configured-but-missing key file fails the pack. Consumers verify after
downloading:

```sh
bunx vite-node scripts/verify-release.ts seraphos@0.2.0.zip \
    seraphos@0.2.0.zip.ed25519.sig scripts/release-public.pem
```

## Security notes

- Report vulnerabilities privately (see SECURITY.md).
- The last administrator can be neither demoted nor disabled.
- Passwords: scrypt N=16384 r=8, 64-byte keys, per-credential salts,
  timing-safe comparison. Session tokens: 32 random bytes, stored only as
  SHA-256 hashes.
- Known limits vs a full zero-trust spec: the LAN is still trusted for
  unauthenticated probing of program assets (per the upstream design).