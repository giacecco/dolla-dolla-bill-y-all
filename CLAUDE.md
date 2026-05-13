# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log Anthropic API token usage. Single file: `dolladollabillyall`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `./token-usage.jsonl`.
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response.
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc to the handler via class attributes.
- `parse_args()` — extracts `-o`/`--ollama-model` from argv, returns the model name (or None) and the remaining args for claude.
- `main()` — parses args, configures upstream (Ollama if `-o` set, otherwise `ANTHROPIC_BASE_URL` or default), starts proxy, runs `claude` via `subprocess.run` with inherited stdio, prints summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming (SSE): incrementally decompresses gzip, buffers all events, scans `message_start` (Anthropic input + cache fields at `message.usage.*`), `message_delta` (Ollama usage, Anthropic output tokens), and `message_stop` (fallback).
- Prompt caching explains the large token-count difference between Anthropic (cached) and Ollama (uncached). Cache fields appear in the log only when non-zero.
- Endpoint is cleaned of query strings before logging.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`.

## Ollama support

The `-o`/`--ollama-model` flag auto-configures: upstream set to `http://<OLLAMA_HOST>` (default `127.0.0.1:11434`), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` removed from env, and `--model <model>` prepended to claude args.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `./token-usage.jsonl` is project-local runtime data — do not commit it.
