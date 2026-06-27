# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log API token usage. Single file: `ddbya`. Reporting script: `ddbya-report`. Desktop tray app (Electron): `desktop/`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `.ddbya.d/usage-<identity>-<session>.ddbya` (see Identity & layout).
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response.
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc/base-path, tags, and `log_path` to the handler via class attributes. The upstream URL's path component is preserved as `upstream_base_path` and prepended to every forwarded request — required for any endpoint whose Anthropic-compatible API lives under a non-root path.
- `parse_args()` — extracts `-t`/`--tag`, `--list-tags`, and `-h`/`--help` from argv. Merges `DDBYA_TAGS` env var (comma-separated) with `-t` flags. Returns `(tags, list_tags, show_help, claude_args)`. `-t`/`--tag` can be given multiple times.
- `collect_tags()` — scans `.ddbya.d/usage-*.ddbya` in the current project and sibling directories, **plus the Claude Desktop log root** (`~/Library/Application Support/ddbya/` on macOS), returning all unique tags found. Used by `--list-tags` for shell tab completion of `-t`/`--tag` values.
- `_claude_desktop_log_root()` — returns the platform-specific ddbya app-support root that holds Claude Desktop logs.
- `_sanitise_identity(s)` — lowercases s and collapses runs of non-`[a-z0-9._-]` chars to a single `-`. Returns `"anonymous"` if the result is empty.
- `_resolve_identity()` — determines the per-user identity string used in log filenames. Resolution order: `git config user.email` → `$USER` → UUID stored in `~/.config/ddbya/id` (generated on first call if absent).
- `_migrate_legacy_layout(project_dir, identity)` — idempotent startup migration. Moves `.token-usage.ddbya` → `.ddbya.d/usage-<identity>-<session>.ddbya` if the legacy file exists at the project root. Prints one line to stderr if moved.
- `main()` — parses args, resolves identity and calls `_migrate_legacy_layout`, configures upstream from `ANTHROPIC_BASE_URL` (or default), starts proxy. If `--help` is given, prints help and exits. If `--list-tags` is given, prints collected tags and exits. Sets `ANTHROPIC_BASE_URL` to the proxy URL. Runs `claude` via `subprocess.Popen` with inherited stdio. Prints session summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, and `model`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`, model at `message.model`), `message_delta` (output tokens), and `message_stop` (fallback for tokens and model). Model is taken from the response, not the request, so aliased model names resolve to their actual deployed model.
- A `"tags"` list is written into every entry when `-t`/`--tag` is given at launch (can be given multiple times). Tags associate consumption with a purpose independently of the project folder.
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Cache fields appear in the log only when non-zero. `model` is omitted if empty (e.g. non-inference endpoints).
- Timestamps are ISO 8601 UTC.

## No dependencies

`ddbya` and `ddbya-report` use only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`, `uuid`, `itertools`, `time`.

## Identity & layout

Each project stores all ddbya state in a `.ddbya.d/` subdirectory:

```
<project>/
  .ddbya.d/
    usage-alice-example.com-3f2a1b9c.ddbya ← Alice's token log (one file per session)
    usage-alice-example.com-7d4e2a1f.ddbya ← Alice's second session
    usage-bob-example.com-9c8b5e3a.ddbya   ← Bob's token log
```

Per-session filenames use the pattern `usage-<identity>-<session>.ddbya`, where `<session>` is an 8-character random hex string (`uuid.uuid4().hex[:8]`) generated at startup. Each invocation of `ddbya` creates its own file, so parallel sessions from the same user never share a write target. Identity is resolved at startup via `_resolve_identity()`: `git config user.email` → `$USER` → UUID stored in `~/.config/ddbya/id`. The identity is sanitised to lowercase `[a-z0-9._-]` (any other character collapsed to `-`).

**Migration:** if a legacy `.token-usage.ddbya` exists at the project root, `_migrate_legacy_layout()` renames it into `.ddbya.d/` on the first ddbya run after the upgrade, attributed to the current user.

## Reporting

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects, always including Claude Desktop logs as project `*Claude Desktop*`.

```
ddbya-report /path/to/projects [--last N | --today] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--model <model> ...] [--json | --csv]
ddbya-report --help   (no folder required)
```

- If the given folder directly contains a `.ddbya.d/` with usage files, reports on that project only. Otherwise scans subdirectories recursively for `.ddbya.d/usage-*.ddbya` files.
- **Claude Desktop logs** (`~/Library/Application Support/ddbya/Claude Desktop/.ddbya.d/` on macOS; `%APPDATA%\ddbya\Claude Desktop\.ddbya.d\` on Windows) are always included as project `*Claude Desktop*`, unless they are already within the specified root (to avoid double-counting).
- Legacy `.token-usage.ddbya` files (not yet migrated) are also read as a fallback.
- Project name = top-level subfolder under the given root that contains the `.ddbya.d/` directory (first path component after root). If the directory is directly in root, uses root's directory name.
- Aggregates by project, model, and tags (across all per-user files in the same project). A Model column appears whenever any entry has a model field; a Tags column appears whenever any entry has tags.
- Includes all data by default. Pass `--last`, `--from`, `--to`, or `--today` to filter by date. `--today` is shorthand for `--from <today> --to <today>` and is mutually exclusive with `--last`, `--from`, and `--to`.
- `--from`/`--to` can be used together or individually; `--from` without `--to` means "from that date to now".
- `-t`/`--tag` filters to entries containing that tag. Can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. Example: `ddbya-report . -t /^Steve/ -t "code review"` matches entries whose tags include one starting with "Steve" AND one exactly "code review".
- `--model` filters to entries whose model field matches the given value. Can be given multiple times (OR logic — entry matches if its model matches any filter). Supports `/ /` regex syntax. Example: `ddbya-report . --model /sonnet/ --model /opus/` matches entries from any Sonnet or Opus model.
- `-t`/`--tag` with `+`/`-` prefix triggers retagging mode instead of reporting:
  - `-t +tagname` adds "tagname" to all matching entries.
  - `-t -tagname` removes "tagname" from all matching entries. Wrap in `/ /` for regex: `-t -/^Steve/`.
  - Retagging modifies `.ddbya.d/usage-*.ddbya` files in-place. Cannot be combined with `--json`/`--csv`.
  - Retagging also operates on Claude Desktop log files.
  - Example: `ddbya-report . -t foobar -t +hello` adds "hello" to every entry that has tag "foobar".
- A spinner is shown on stderr while data is being read (only when stderr is a TTY).
- Zero dependencies — Python 3 standard library only.

## Desktop app

`desktop/` contains an Electron tray app that intercepts Claude Desktop's API traffic the same way `ddbya` wraps Claude Code.

### What it does

- Sits in the macOS menu bar (or Windows system tray) as a small icon (Claude asterisk + $ sign).
- Starts a local reverse proxy on a persistent port (default 18723, stored in `~/Library/Application Support/ddbya/state.json`).
- Registers the proxy URL with the OS (`launchctl setenv ANTHROPIC_BASE_URL` on macOS; Windows registry on Windows) so that Claude Desktop picks it up on next launch.
- If the persistent port is already in use at startup, picks a random free port and shows a persistent warning dialog asking the user to restart Claude Desktop.
- Logs token usage to `~/Library/Application Support/ddbya/Claude Desktop/.ddbya.d/usage-<identity>-<session>.ddbya` (macOS) or `%APPDATA%\ddbya\Claude Desktop\.ddbya.d\...` (Windows).
- On quit: unregisters the env var so future Claude Desktop launches go to the real API directly.

### Menu

- **Change Tags…** — opens a window to set tags that will be applied to all subsequent log entries. Past tags from Claude Desktop logs are suggested.
- **Export Report (CSV)…** — opens a window to pick a date range and export a CSV of Claude Desktop token usage via `ddbya-report`.
- **Launch Claude Desktop** — launches Claude Desktop with the proxy env var already set in its environment.
- **Quit** — stops the proxy and unregisters the env var.

### File layout

```
desktop/
  main.js                ← Electron main process: proxy + tray + IPC
  preload.js             ← contextBridge API for renderer windows
  package.json
  .gitignore
  renderer/
    tags.html            ← tags management UI
    report.html          ← CSV export UI
  assets/
    icon.svg             ← source icon (committed)
    icon.png             ← generated at build time (not committed)
    icon.icns            ← generated at build time (not committed)
    icon.ico             ← generated at build time (not committed)
  macos/
    build.sh             ← full build → sign → notarize → deploy pipeline
    electron-builder.yml ← packaging config (signing disabled; handled by sign.js)
    sign.js              ← custom signing script (see Signing note below)
    entitlements.plist   ← hardened runtime entitlements
    generate-icons.js    ← qlmanage + ImageMagick icon generator
    dist/                ← build output (not committed)
  windows/
    electron-builder.yml ← Windows packaging config
    build.ps1            ← Windows build script
    dist/                ← build output (not committed)
```

### Building for macOS

```bash
bash desktop/macos/build.sh
```

Requirements:
- Node.js and npm
- ImageMagick (`brew install imagemagick`)
- Xcode Command Line Tools (for `codesign`, `iconutil`, `xcrun notarytool`)
- A notarisation app-specific password stored in Keychain as profile `ddbya-notarize` (the build script will prompt to create it on first run — generate the password at appleid.apple.com → App-Specific Passwords)

Signing identity: `Developer ID Application: Gianfranco Cecconi (W52V7H5858)`

The script kills any running instance, builds a universal binary (arm64 + x86_64), signs with the Developer ID certificate, notarizes with Apple, staples the ticket, copies to `/Applications/`, and launches the new version.

**Signing note:** electron-builder's built-in signing is disabled (`identity: null` in the yml) because macOS Spotlight re-adds `com.apple.FinderInfo` to `.app` directories almost immediately after `xattr -d`, causing `codesign` to fail with "resource fork, Finder information, or similar detritus not allowed". `macos/sign.js` works around this by stripping that xattr immediately before each individual `codesign` call (within the same Node.js tick, before the filesystem daemon can restore it), retrying up to 5 times per item.

### Windows

```bash
cd desktop && npm install && npx electron-builder --win --config windows/electron-builder.yml
```

Or via PowerShell: `.\windows\build.ps1`

Windows Authenticode signing is not yet configured (no certificate on file). Run `signtool.exe` manually or add a cert path to `windows/electron-builder.yml` when a certificate is available.

## Maintenance

- When a new Claude Code version is released, verify that none of ddbya's own short flags (`-t`) or long flags (`--tag`, `--list-tags`, `--help`) conflict with new flags introduced by Claude Code itself. A conflict would shadow or consume a flag meant for the wrapped `claude` process.
- When the Electron app's proxy port changes (because the default port is in use), the user must restart Claude Desktop to pick up the new URL. The app shows a warning dialog when this happens.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `.ddbya.d/` is committed to this repository. Per-user `usage-*.ddbya` files are committed so consumption history is preserved in the repo.
