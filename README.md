# Seraph OS

Seraph OS is a multi-user web desktop: a server that hosts each user's programs,
files, and AI assistant, and a browser desktop they sign into individually.

It began as a fork of [PhreshOS/system](https://github.com/PhreshOS/system)
(MIT, © 2026 Zohayr SLILEH), rebranded and extended with:

- **Individual logins.** Admin-managed accounts. Each user gets a private
  desktop, private programs, private storage, and per-user sessions.
- **Persistent per-user memory.** Account store, preferences, assistant
  conversation history, and long-term assistant memory, all SQLite-backed
  under one home directory per user.
- **Seraph, the built-in AI assistant.** A chat Program with streaming output,
  tool-calling into the desktop (launch programs, read/write the user's files,
  change settings), and durable long-term memory.

## Status

Phase 1 (fork, rebrand, boot) is complete. Phase 2 (multi-user kernel) is in
progress — see `PLAN.md` for the current build state.

## Development

You need [Bun](https://bun.sh) 1.3 and Node.js 24.15 or newer.

```sh
bun install --frozen-lockfile
bun run dev
```

`dev` runs the System from source, with its data in `storage/` in this
repository and the Desktop on the first free port from `6300`. An installed
System uses `~/.seraphos` and ports from `6400`, so both can run side by side.
`SERAPHOS_HOME` and `SERAPHOS_PORT` choose another home or port.

| Command | Does |
| --- | --- |
| `bun run check` | Type-checks the source |
| `bun run build` | Builds the server and the Desktop into `dist/` |
| `bun run test` | Runs the tests in `tests/` |
| `bun run verify` | Runs `check`, `build`, and `test`, including a test that packs the release, installs it in a temporary folder, and boots it |
| `bun run pack` | Builds the release archive and its checksum |

The source has three parts: `source/server` is the System, `source/client` is
the Desktop, and `source/shared` holds what both use.

## Origins and license

Seraph OS is a fork of PhreshOS (MIT). The original PhreshOS — by
Zohayr SLILEH and its contributors — lives at
[github.com/PhreshOS](https://github.com/PhreshOS), with documentation at
[phreshos.com/docs](https://phreshos.com/docs). The `@phreshos/core` and
`@phreshos/react-ui` packages are used as published dependencies of this
fork under their MIT license; the pinned protocol internal
(`__PHRESHOS_SERVER_TRANSPORT__`, sandbox transport calls) is intentionally
preserved for SDK compatibility.

## License

[MIT](LICENSE). Copyright © 2026 steph (Seraph OS modifications);
original PhreshOS © 2026 Zohayr SLILEH.