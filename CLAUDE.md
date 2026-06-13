# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log API token usage across Anthropic, DeepSeek, and cloud-provider backends. Single file: `ddbya`. Reporting script: `ddbya-report`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `.ddbya.d/usage-<identity>-<session>.ddbya` (see Identity & layout).
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response. Implements path-prefix routing: when `extra_upstreams` is non-empty, a matching prefix (e.g. `/--bedrock`) is stripped and the request is forwarded to the corresponding cloud-provider upstream.
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc/base-path, tags, programmatic flag, `log_path`, and `extra_upstreams` to the handler via class attributes. The upstream URL's path component is preserved as `upstream_base_path` and prepended to every forwarded request that does not match an `extra_upstreams` prefix — required for DeepSeek (`https://api.deepseek.com/anthropic`) and any enterprise gateway whose Anthropic-compatible endpoint lives under a non-root path.
- `parse_args()` — extracts `--deepseek`, `-t`/`--tag`, and `--list-tags` from argv. Returns `(deepseek, tags, list_tags, claude_args)`. `-t`/`--tag` can be given multiple times.
- `collect_tags()` — scans `.ddbya.d/usage-*.ddbya` in the current project and sibling directories, returning all unique tags found. Used by `--list-tags` for shell tab completion of `-t`/`--tag` values.
- `_sanitise_identity(s)` — lowercases s and collapses runs of non-`[a-z0-9._-]` chars to a single `-`. Returns `"anonymous"` if the result is empty.
- `_resolve_identity()` — determines the per-user identity string used in log filenames. Resolution order: `git config user.email` → `$USER` → UUID stored in `~/.config/ddbya/id` (generated on first call if absent).
- `_migrate_legacy_layout(project_dir, identity)` — idempotent startup migration. Moves `.token-usage.ddbya` → `.ddbya.d/usage-<identity>-<session>.ddbya` if the legacy file exists at the project root. Prints one line to stderr if moved.
- `_build_extra_upstreams()` — reads `ANTHROPIC_BEDROCK_BASE_URL` (or `ANTHROPIC_AWS_BASE_URL`), `ANTHROPIC_VERTEX_BASE_URL`, and `ANTHROPIC_FOUNDRY_BASE_URL` from the environment before they are overridden. Returns a path-prefix → `{scheme, netloc, base_path}` dict consumed by `ReverseProxy`. Only backends whose `*_BASE_URL` env var is already set (indicating the user has an LLM gateway configured) are included. Native-SDK backends (`CLAUDE_CODE_USE_BEDROCK` without a gateway URL) cannot be intercepted without a format-translation layer.
- `main()` — parses args, resolves identity and calls `_migrate_legacy_layout`, detects `-p`/`--print` for programmatic tagging, configures upstream (DeepSeek if `--deepseek` set, otherwise `ANTHROPIC_BASE_URL` or default), calls `_build_extra_upstreams()` to snapshot pre-existing cloud-provider gateway URLs, starts proxy. If `--list-tags` is given, prints collected tags and exits. Sets `ANTHROPIC_BASE_URL` and (for each detected backend) `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` / `ANTHROPIC_FOUNDRY_BASE_URL` to path-prefixed proxy URLs so all configured backends route through the proxy. For `--deepseek`, maps every `DEEPSEEK_*` env var (except `DEEPSEEK_BASE_URL`) to its `ANTHROPIC_*` equivalent and sets `CLAUDE_CODE_SUBAGENT_MODEL=deepseek-v4-flash` and `CLAUDE_CODE_EFFORT_LEVEL=max`. Runs `claude` via `subprocess.Popen` with inherited stdio. Prints session summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`), `message_delta` (output tokens), and `message_stop` (fallback).
- A `"tags"` list is written into every entry when `-t`/`--tag` is given at launch (can be given multiple times). Tags associate consumption with a purpose independently of the project folder.
- A `"programmatic": true` field is added when `-p`/`--print` is detected in claude args, to distinguish non-interactive usage.
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Cache fields appear in the log only when non-zero.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`, `uuid`.

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

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects.

```
ddbya-report /path/to/projects [--last N | --today] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json | --csv]
```

- If the given folder directly contains a `.ddbya.d/` with usage files, reports on that project only. Otherwise scans subdirectories recursively for `.ddbya.d/usage-*.ddbya` files.
- Legacy `.token-usage.ddbya` files (not yet migrated) are also read as a fallback.
- Project name = top-level subfolder under the given root that contains the `.ddbya.d/` directory (first path component after root). If the directory is directly in root, uses root's directory name.
- Aggregates by project, programmatic flag, and tags (across all per-user files in the same project). A Tags column appears whenever any entry has tags.
- Includes all data by default. Pass `--last`, `--from`, `--to`, or `--today` to filter by date. `--today` is shorthand for `--from <today> --to <today>` and is mutually exclusive with `--last`, `--from`, and `--to`.
- `--from`/`--to` can be used together or individually; `--from` without `--to` means "from that date to now".
- `-t`/`--tag` filters to entries containing that tag. Can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. Example: `ddbya-report . -t /^Steve/ -t "code review"` matches entries whose tags include one starting with "Steve" AND one exactly "code review".
- `-t`/`--tag` with `+`/`-` prefix triggers retagging mode instead of reporting:
  - `-t +tagname` adds "tagname" to all matching entries.
  - `-t -tagname` removes "tagname" from all matching entries. Wrap in `/ /` for regex: `-t -/^Steve/`.
  - Retagging modifies `.ddbya.d/usage-*.ddbya` files in-place. Cannot be combined with `--json`/`--csv`.
  - Example: `ddbya-report . -t foobar -t +hello` adds "hello" to every entry that has tag "foobar".
- Zero dependencies — Python 3 standard library only.

## Maintenance

- When a new Claude Code version is released, verify that none of ddbya's own short flags (`-t`, `-p`) or long flags (`--deepseek`, `--tag`, `--list-tags`) conflict with new flags introduced by Claude Code itself. A conflict would shadow or consume a flag meant for the wrapped `claude` process.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `.ddbya.d/` is committed to this repository. Per-user `usage-*.ddbya` files are committed so consumption history is preserved in the repo.
