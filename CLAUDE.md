# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log Anthropic API token usage. Single file: `ddbya`. Reporting script: `ddbya-report`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `./token-usage.jsonl`.
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response. When `proxy.budget_exceeded` is set, refuses new requests with HTTP 429 + a synthetic Anthropic error JSON (`overloaded_error`).
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc, tags, and programmatic flag to the handler via class attributes. Tracks in-flight request count behind a lock and exposes `wait_idle()` plus a `budget_exceeded` Event used by the watchdog for graceful shutdown.
- `BudgetChecker` — daemon thread that scans `token-usage.jsonl` from the current project and immediate sibling directories every minute, computes USD spend from `MODEL_PRICING`, and fires a one-shot `on_exceeded` callback the first time spend crosses 100% of the limit. Maintains a per-file `(mtime, offset, entries)` cache so each tick only reads bytes appended since the last scan; entries that drop out of the lookback window are pruned. Emits stderr warnings when spend crosses 80/85/90% and each integer percentage from 95–99% (crossing, not landing — spend can jump several points between ticks). On the first tick of a session that starts already past one or more thresholds, fires a single warning at the highest crossed threshold rather than one per threshold below the current pct. At 100%+ the exceeded message is shown instead so the percentage line doesn't duplicate it. Warnings are deferred while requests are in flight: claude's full-screen TUI repaints over stderr output mid-stream, so the message is stashed and flushed on the next tick where the proxy reports idle (no in-flight requests). A later crossing while a message is still pending supersedes it — only the most recent budget state is shown. Pre-flight check (before claude launches) refuses the launch outright if already over the limit.
- `MODEL_PRICING` — module-level dict of Anthropic per-million-token prices, matched by longest model-ID prefix. Unknown `claude-*` IDs fall back to Sonnet pricing and are reported at session end so the user can update ddbya.
- `parse_args()` — extracts `-o`/`--ollama-model`, `-l`/`--limit`, `-t`/`--tag`, `--last`, and `--list-tags` from argv. Returns `(ollama_model, limit_usd, lookback_days, tags, list_tags, claude_args)`. Validates that `--limit` and `--last` are paired. `-t`/`--tag` can be given multiple times.
- `collect_tags()` — scans `token-usage.jsonl` in the current project and sibling directories (same scope as `BudgetChecker`), returning all unique tags found. Used by `--list-tags` for shell tab completion of `-t`/`--tag` values.
- `main()` — parses args, detects `-p`/`--print` for programmatic billing tagging, configures upstream (Ollama if `-o` set, otherwise `ANTHROPIC_BASE_URL` or default), starts proxy and (optionally) `BudgetChecker`. If `--list-tags` is given, prints collected tags and exits. Wires `BudgetChecker.on_exceeded → proxy.budget_exceeded.set`. Runs `claude` via `subprocess.Popen` with inherited stdio. When a budget is set, a watchdog thread waits on `proxy.budget_exceeded`, then `proxy.wait_idle()`, then sends `SIGTERM` (escalating to `SIGKILL` after 30 s) so the model finishes any in-flight responses before claude exits. Prints session summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`), `message_delta` (Ollama usage, Anthropic output tokens), and `message_stop` (fallback).
- A `"tags"` list is written into every entry when `-t`/`--tag` is given at launch (can be given multiple times). Tags associate consumption with a purpose independently of the project folder.
- A `"programmatic": true` field is added when `-p`/`--print` is detected in claude args, to distinguish non-interactive usage for billing (relevant from 15 June 2026 Anthropic subscriptions).
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Prompt caching explains the large token-count difference between Anthropic (cached) and Ollama (uncached). Cache fields appear in the log only when non-zero.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`.

## Reporting

`ddbya-report` aggregates `token-usage.jsonl` files across multiple projects.

```
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...]
```

- If the given folder directly contains `token-usage.jsonl`, reports on that project only. Otherwise scans subdirectories recursively for `token-usage.jsonl` files.
- Project name = top-level subfolder under the given root that contains the log file (first path component after root). If the log file is directly in root, uses root's directory name.
- Aggregates by project, model, programmatic flag, and tags. A Tags column appears whenever any entry has tags.
- Defaults to last 7 days if no time filter is given.
- `--from`/`--to` can be used together or individually; `--from` without `--to` means "from that date to now".
- `-t`/`--tag` filters to entries containing that tag. Can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. Example: `ddbya-report . -t /^Steve/ -t "code review"` matches entries whose tags include one starting with "Steve" AND one exactly "code review".
- Zero dependencies — Python 3 standard library only.
- Pricing (`MODEL_PRICING`, default, prefix list) is loaded at startup from the sibling `ddbya` file via `importlib.machinery.SourceFileLoader`, so the two scripts share a single source of truth. Both must be installed in the same directory.

## Ollama support

The `-o`/`--ollama-model` flag auto-configures: upstream set to `http://<OLLAMA_HOST>` (default `127.0.0.1:11434`), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` removed from env, and `--model <model>` prepended to claude args.

## Maintenance

- When a new Claude Code version is released, verify that none of ddbya's own short flags (`-o`, `-l`, `-t`, `-p`) or long flags (`--ollama-model`, `--limit`, `--last`, `--tag`, `--list-tags`) conflict with new flags introduced by Claude Code itself. A conflict would shadow or consume a flag meant for the wrapped `claude` process.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `./token-usage.jsonl` is project-local runtime data — do not commit it.
