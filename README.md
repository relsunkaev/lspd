# lspd

LSP multiplexer daemon for sharing language server instances across multiple editors.

This project is Bun/TypeScript-based (it previously had a Rust implementation, which has been removed).

## Problem

If you open multiple editor instances on the same project (multiple Neovim windows, OpenCode + Neovim, etc.), each client usually spawns its own language server process. For heavier servers like `tsgo`, this can waste a lot of CPU and memory.

## Solution

`lspd` sits between your editor(s) and the language server. It runs a single server process per `(projectRoot, serverName)` pair and multiplexes multiple editor clients to it.

## Features

- Shared LSP instances (one per project + server)
- Automatic lifecycle (daemon starts on first connection; exits after last client disconnects)
- Binary discovery (prefers `node_modules/.bin`, with env overrides)
- Request id translation (prevents collisions across multiple clients)
- Diagnostics bridging for mixed clients
  - If a client doesn’t support pull diagnostics (`textDocument/diagnostic`), the mux bridges pull->push using `textDocument/publishDiagnostics`.

## Installation

This package requires `bun` to be installed (the CLI is a small Node wrapper that spawns Bun).

```bash
npm install -g lspd
# or
bun add -g lspd
```

## Usage

### Connect (used by editors)

```bash
lspd connect tsgo --project /path/to/project
lspd connect oxlint --project /path/to/project
```

Your editor should start `lspd connect <server>` and speak LSP over stdin/stdout.

### Neovim example

```lua
-- instead of: cmd = { "tsgo", "--lsp", "-stdio" }
cmd = { "lspd", "connect", "tsgo", "--project", vim.loop.cwd() }
```

## Configuration

Environment variables:

- `LSPD_TSGO_BIN=/absolute/path/to/tsgo`
- `LSPD_OXLINT_BIN=/absolute/path/to/oxlint`

## How it works (high-level)

- `lspd connect <server>` ensures a per-project daemon is running.
- The daemon listens on a Unix domain socket under:
  - `~/.cache/lspd/daemons/<id>/daemon.sock`
- All connected clients are multiplexed into a single server process, with request/response routing handled via translated ids.

## Development

```bash
bun test
```

Notes:

- The smoke tests use `test-fixtures/proj` and will run `bun install` there as needed.
- The `tsgo` smoke test may build `tsgo` from source if the prebuilt binary hangs, which requires `git`, `go`, and network access.

## License

MIT (see `LICENSE`).
