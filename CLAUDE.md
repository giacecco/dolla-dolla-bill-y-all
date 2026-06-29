# CLAUDE.md

## Project

A Node.js reverse proxy that wraps Claude Code to intercept and log API token usage. CLI: `ddbya`. Reporting script: `ddbya-report`. Desktop tray app (Electron): `desktop/`.

Shared modules (zero npm dependencies — Node.js built-ins only):
- `proxy-core.js` — reverse proxy, token logging, identity resolution. Used by `ddbya` and `desktop/main.js`.
- `report-core.js` — entry discovery, aggregation, table/CSV formatting, retagging. Used by `ddbya-report` and imported directly by `desktop/main.js` for CSV export (no Python subprocess).

## Platform support

All components — `ddbya`, `ddbya-report`, and `desktop/` — must work correctly on Windows, macOS, and Linux. Use `path` from Node.js for all file paths, `process.platform` for any OS-specific branches, and avoid shell-isms that don't work on Windows.

## Architecture

### proxy-core.js

- `TokenLogger` — JSONL writer with in-memory session tracking. Writes to `.ddbya.d/usage-<identity>-<session>.ddbya`. `summary()` returns totals for the session.
- `buildProxy(upstream, logger, tagsGetter, optsRef, onTokens)` — creates an `http.Server` that forwards all methods to the upstream, relays streaming (SSE) and non-streaming responses, and extracts `usage` from each response. `optsRef.disableBeta` may be mutated after creation for live effect. `onTokens(n)` is an optional callback fired after each logged entry (used by the desktop tray counter).
- `resolveIdentity(opts)` — determines the per-user identity string. Resolution order: `git config --global user.email` → `os.userInfo().username` → UUID stored via `opts.getStored`/`opts.setStored` (default: `~/.config/ddbya/id`).
- `sanitiseIdentity(s)` — lowercases s and collapses runs of non-`[a-z0-9._-]` chars to a single `-`. Returns `"anonymous"` if the result is empty.

### ddbya (CLI wrapper)

- `parseArgs(argv)` — extracts `-t`/`--tag`, `--list-tags`, and `-h`/`--help` from argv. Merges `DDBYA_TAGS` env var (comma-separated) with `-t` flags.
- `collectTags(projectDir)` — scans `.ddbya.d/usage-*.ddbya` in the current project and sibling directories, **plus the Claude Desktop log root**, returning all unique tags sorted. Used by `--list-tags` for shell tab completion.
- `migrateLegacyLayout(projectDir, identity, sessionId)` — idempotent startup migration. Moves `.token-usage.ddbya` → `.ddbya.d/usage-<identity>-<session>.ddbya` if the legacy file exists.
- `main()` — parses args, resolves identity, runs migration, starts proxy on a random port, spawns `claude` with `ANTHROPIC_BASE_URL` pointing at the proxy, prints session summary to stderr on exit.

### report-core.js

- `collectEntries(root, fromDate, toDate, tagFilters, modelFilters)` — discovers all `.ddbya.d/usage-*.ddbya` files under root (or in root directly), plus Claude Desktop logs, and returns filtered entry records.
- `aggregate(entries)` — groups by `(project, model, tags)` and sums token counts.
- `report(rows, fromDate, toDate)` — prints a formatted table to stdout.
- `csvReport(rows)` — returns a CSV string.
- `retag(root, fromDate, toDate, tagFilters, addTags, removeTags)` — modifies tags in `.ddbya.d/usage-*.ddbya` files in-place (atomic write via temp file + rename).

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`, and `model`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`, model at `message.model`), `message_delta` (output tokens), and `message_stop` (fallback for tokens and model). Model is taken from the response, not the request, so aliased model names resolve to their actual deployed model.
- A `"tags"` list is written into every entry when `-t`/`--tag` is given at launch (can be given multiple times). Tags associate consumption with a purpose independently of the project folder.
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Cache fields appear in the log only when non-zero. `model` is omitted if empty (e.g. non-inference endpoints).
- Timestamps are ISO 8601 UTC.

## No dependencies

`ddbya`, `ddbya-report`, `proxy-core.js`, and `report-core.js` use only Node.js built-in modules: `http`, `https`, `fs`, `path`, `os`, `crypto`, `zlib`, `child_process`, `net`. No npm install required.

## Identity & layout

Each project stores all ddbya state in a `.ddbya.d/` subdirectory:

```
<project>/
  .ddbya.d/
    usage-alice-example.com-3f2a1b9c.ddbya ← Alice's token log (one file per session)
    usage-alice-example.com-7d4e2a1f.ddbya ← Alice's second session
    usage-bob-example.com-9c8b5e3a.ddbya   ← Bob's token log
```

Per-session filenames use the pattern `usage-<identity>-<session>.ddbya`, where `<session>` is an 8-character random hex string (`crypto.randomUUID().slice(0,8)`) generated at startup. Each invocation of `ddbya` creates its own file, so parallel sessions from the same user never share a write target. Identity is resolved at startup via `resolveIdentity()`: `git config --global user.email` → `os.userInfo().username` → UUID stored in `~/.config/ddbya/id`. The identity is sanitised to lowercase `[a-z0-9._-]` (any other character collapsed to `-`).

**Migration:** if a legacy `.token-usage.ddbya` exists at the project root, `_migrate_legacy_layout()` renames it into `.ddbya.d/` on the first ddbya run after the upgrade, attributed to the current user.

## Reporting

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects, always including Claude Desktop logs as project `*Claude Desktop*`.

```
ddbya-report /path/to/projects [--last N | --today] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--model <model> ...] [--json | --csv]
ddbya-report --help   (no folder required)
```

- If the given folder directly contains a `.ddbya.d/` with usage files, reports on that project only. Otherwise scans subdirectories recursively for `.ddbya.d/usage-*.ddbya` files.
- **Claude Desktop logs** (`~/Library/Application Support/ddbya/Claude Desktop/.ddbya.d/` on macOS; `%APPDATA%\ddbya\Claude Desktop\.ddbya.d\` on Windows) are always included as project `*Claude Desktop*`, unless they are already within the specified root (to avoid double-counting). `*Claude Desktop*` does not get a `(subtotal)` row in tabular output.
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

## Building and running

To build and run the desktop app on macOS, use the dedicated build script:

```bash
bash desktop/macos/build.sh
```

This is the only supported build command on macOS — do not use `npm start` or `npx electron .` directly. The script stops any running instance, packages a universal binary, signs it, copies it to `/Applications/`, and launches it.

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
  linux/
    electron-builder.yml ← Linux packaging config (AppImage, x64 + arm64)
    build.sh             ← Linux build script
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

**Notarisation timing:** notarise only immediately before `git push`, not on every local build. Notarisation uploads the binary to Apple's servers and takes ~1 minute — unnecessary overhead for iterative local development. To build and deploy locally without notarisation, run the individual steps from `build.sh` up to but not including `xcrun notarytool submit`.

**Signing note:** electron-builder's built-in signing is disabled (`identity: null` in the yml) because macOS Spotlight re-adds `com.apple.FinderInfo` to `.app` directories almost immediately after `xattr -d`, causing `codesign` to fail with "resource fork, Finder information, or similar detritus not allowed". `macos/sign.js` works around this by stripping that xattr immediately before each individual `codesign` call (within the same Node.js tick, before the filesystem daemon can restore it), retrying up to 5 times per item.

### Windows

```bash
cd desktop && npm install && npx electron-builder --win --config windows/electron-builder.yml
```

Or via PowerShell: `.\windows\build.ps1`

Windows Authenticode signing is not yet configured (no certificate on file). Run `signtool.exe` manually or add a cert path to `windows/electron-builder.yml` when a certificate is available.

### Linux

```bash
bash desktop/linux/build.sh
```

Requirements:
- Node.js and npm
- ImageMagick (`apt install imagemagick` / `dnf install ImageMagick`)

Produces an AppImage (x64 and arm64) in `desktop/linux/dist/`. AppImages are self-contained and require no installation — the user makes it executable and runs it.

Linux signing is not configured. AppImages can be signed with `gpg` but this is not required for distribution.

**Env var registration on Linux:** `setProxyEnv()` writes `~/.config/environment.d/ddbya.conf` (or `$XDG_CONFIG_HOME/environment.d/ddbya.conf`), which is picked up by systemd user sessions on login. Users on non-systemd distros will need to set `ANTHROPIC_BASE_URL` manually in their shell RC or launch Claude Desktop through ddbya Desktop's "Launch Claude Desktop" menu item (which passes the env var directly to the child process).

**Log root on Linux:** `$XDG_DATA_HOME/ddbya` (defaults to `~/.local/share/ddbya`). This matches what `ddbya` and `ddbya-report` use on Linux.

**Claude Desktop binary lookup on Linux:** tries `~/.local/bin/claude-desktop`, `/usr/bin/claude-desktop`, `/usr/local/bin/claude-desktop`, and `/opt/claude-desktop/claude-desktop` in order.

## Maintenance

- When a new Claude Code version is released, verify that none of ddbya's own short flags (`-t`) or long flags (`--tag`, `--list-tags`, `--help`) conflict with new flags introduced by Claude Code itself. A conflict would shadow or consume a flag meant for the wrapped `claude` process.
- When the Electron app's proxy port changes (because the default port is in use), the user must restart Claude Desktop to pick up the new URL. The app shows a warning dialog when this happens.

## Secret features

Some features are intentionally hidden from users who don't know to look for them. Do not document them in README files, user-facing help text, or `--help` output.

- **`ddbya-report --dollars <csv-path>`** — adds a Cost (USD) column to reports by loading a pricing CSV. The `--dollars` flag must not appear in the `--help` output or any documentation.
- **ddbya Desktop cost display** — in the Settings window, clicking the "Settings" heading 5 times reveals a hidden section to load a pricing CSV. The tray then shows estimated cost (e.g. `$0.03`) instead of token counts, with a ⚠ prefix when some models are not in the CSV. This must not be mentioned in the README or any visible UI text.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `.ddbya.d/` is committed to this repository. Per-user `usage-*.ddbya` files are committed so consumption history is preserved in the repo.
