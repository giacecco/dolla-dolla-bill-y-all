# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log Anthropic API token usage. Single file: `ddbya`. Reporting script: `ddbya-token-report`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `./token-usage.jsonl`.
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response. When `proxy.budget_exceeded` is set, refuses new requests with HTTP 429 + a synthetic Anthropic error JSON (`overloaded_error`).
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc to the handler via class attributes. Tracks in-flight request count behind a lock and exposes `wait_idle()` plus a `budget_exceeded` Event used by the watchdog for graceful shutdown.
- `BudgetChecker` — daemon thread that re-reads `token-usage.jsonl` from the current project and immediate sibling directories every 5 minutes, computes USD spend from `MODEL_PRICING`, and fires a one-shot `on_exceeded` callback the first time spend crosses 100% of the limit. Emits stderr warnings at 80/85/90/95%+. Pre-flight check (before claude launches) refuses the launch outright if already over the limit.
- `MODEL_PRICING` — module-level dict of Anthropic per-million-token prices, matched by longest model-ID prefix. Unknown `claude-*` IDs fall back to Sonnet pricing and are reported at session end so the user can update ddbya.
- `parse_args()` — extracts `-o`/`--ollama-model`, `-l`/`--limit`, `--last`, and `--debug` from argv. Returns `(ollama_model, limit_usd, lookback_days, debug, claude_args)`. Validates that `--limit` and `--last` are paired.
- `main()` — parses args, detects `-p`/`--print` for programmatic billing tagging, configures upstream (Ollama if `-o` set, otherwise `ANTHROPIC_BASE_URL` or default), starts proxy and (optionally) `BudgetChecker`. Wires `BudgetChecker.on_exceeded → proxy.budget_exceeded.set`. Runs `claude` via `subprocess.Popen` with inherited stdio. When a budget is set, a watchdog thread waits on `proxy.budget_exceeded`, then `proxy.wait_idle()`, then sends `SIGTERM` (escalating to `SIGKILL` after 30 s) so the model finishes any in-flight responses before claude exits. Prints session summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`), `message_delta` (Ollama usage, Anthropic output tokens), and `message_stop` (fallback).
- A `"programmatic": true` field is added when `-p`/`--print` is detected in claude args, to distinguish non-interactive usage for billing (relevant from 15 June 2026 Anthropic subscriptions).
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Prompt caching explains the large token-count difference between Anthropic (cached) and Ollama (uncached). Cache fields appear in the log only when non-zero.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`.

## Reporting

`ddbya-token-report` aggregates `token-usage.jsonl` files across multiple projects.

```
ddbya-token-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

- If the given folder directly contains `token-usage.jsonl`, reports on that project only. Otherwise scans immediate subdirectories (one level deep).
- Project name = immediate parent directory containing the log file.
- Aggregates by project, model, and programmatic flag.
- Defaults to last 7 days if no time filter is given.
- `--from`/`--to` can be used together or individually; `--from` without `--to` means "from that date to now".
- Zero dependencies — Python 3 standard library only.

## Ollama support

The `-o`/`--ollama-model` flag auto-configures: upstream set to `http://<OLLAMA_HOST>` (default `127.0.0.1:11434`), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` removed from env, and `--model <model>` prepended to claude args.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `./token-usage.jsonl` is project-local runtime data — do not commit it.
