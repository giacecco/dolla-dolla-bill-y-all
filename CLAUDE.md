# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log Anthropic API token usage. Single file: `dolladollabillyall`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `./token-usage.jsonl`.
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response.
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc to the handler via class attributes.
- `main()` — reads original `ANTHROPIC_BASE_URL`, starts proxy, runs `claude` via `subprocess.run` with inherited stdio, prints summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, looks for `usage.input_tokens` / `usage.output_tokens`.
- Streaming (SSE): buffers all events, scans `message_stop` and `message_delta` lines for the usage block. Handles both Anthropic and Ollama event formats.
- Endpoint is cleaned of query strings before logging.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `./token-usage.jsonl` is project-local runtime data — do not commit it.
