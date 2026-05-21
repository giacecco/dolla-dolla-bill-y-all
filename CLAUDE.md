# CLAUDE.md

## Project

A zero-dependency Python 3 reverse proxy that wraps Claude Code to intercept and log Anthropic API token usage. Single file: `ddbya`. Reporting script: `ddbya-report`.

## Architecture

- `TokenLogger` — thread-safe JSONL writer with in-memory session tracking. Writes to `.ddbya.d/usage-<identity>-<session>.ddbya` (see Identity & layout).
- `ReverseProxyHandler` — `http.server.BaseHTTPRequestHandler` subclass. Forwards any HTTP method to the upstream, relays streaming (SSE) and non-streaming responses chunk-by-chunk, and extracts `usage` from the response. Implements path-prefix routing: when `extra_upstreams` is non-empty, a matching prefix (e.g. `/--bedrock`) is stripped and the request is forwarded to the corresponding cloud-provider upstream with its billing mode set accordingly. Also watches for the `rate_limit_event` SSE event (type `"rate_limit_event"`, overage flag at `rate_limit_info.isUsingOverage`) to detect subscription overage (see Token extraction). When `proxy.budget_exceeded` is set, refuses new requests with HTTP 429 + a synthetic Anthropic error JSON (`overloaded_error`).
- `ReverseProxy` — manages the `ThreadingHTTPServer` lifecycle. Binds to port 0 for auto-selection, passes upstream scheme/netloc, tags, programmatic flag, `log_path`, and `extra_upstreams` to the handler via class attributes. Tracks in-flight request count behind a lock and exposes `wait_idle()` plus a `budget_exceeded` Event used by the watchdog for graceful shutdown.
- `BudgetChecker` — daemon thread that scans `.ddbya.d/usage-*.ddbya` from the current project and immediate sibling directories every minute, computes USD spend from `MODEL_PRICING`, and fires a one-shot `on_exceeded` callback the first time spend crosses 100% of the limit. Maintains a per-file `(mtime, offset, entries)` cache so each tick only reads bytes appended since the last scan; entries that drop out of the lookback window are pruned. Emits stderr warnings when spend crosses 80/85/90% and each integer percentage from 95–99% (crossing, not landing — spend can jump several points between ticks). On the first tick of a session that starts already past one or more thresholds, fires a single warning at the highest crossed threshold rather than one per threshold below the current pct. At 100%+ the exceeded message is shown instead so the percentage line doesn't duplicate it. Warnings are deferred while requests are in flight: claude's full-screen TUI repaints over stderr output mid-stream, so a `_warning_pending` flag is raised and the message is rendered on the next tick where the proxy reports idle (no in-flight requests). Rendering happens at flush time using the current cost so the user sees the latest state, not a stale snapshot from the tick on which the threshold was crossed. Pre-flight check (before claude launches) refuses the launch outright if already over the limit.
- `MODEL_PRICING` — module-level dict of Anthropic per-million-token prices, matched by longest model-ID prefix. Serves as the fallback when `.ddbya.d/pricing.ddbya` has no record covering an entry's date. Unknown `claude-*` IDs fall back to Sonnet pricing and are reported at session end so the user can update ddbya.
- `_EMBEDDED_PRICING_RECORDS` — list of pricing record dicts (same schema as `.ddbya.d/pricing.ddbya`) baked into the script. Used to bootstrap `.ddbya.d/pricing.ddbya` on first run in any project directory without a network fetch. `to` and `fetched_at` are omitted in the constant and filled in at bootstrap time. Run `ddbya --pricing` to replace with live data.
- `find_pricing_for(model, timestamp, pricing_records)` — date-aware pricing lookup. Finds the most-recent record in `pricing_records` whose `from` date is ≤ the entry's timestamp date, falling back to `MODEL_PRICING` then `_DEFAULT_PRICING`. Shared between `ddbya` and `ddbya-report` via `_load_pricing_from_ddbya`.
- `maybe_update_pricing(project_dir, force)` — ensures `.ddbya.d/pricing.ddbya` exists on startup. If the file is absent, bootstraps it silently from `_EMBEDDED_PRICING_RECORDS` (no prompt, no network call). With `force=True` (`--pricing` flag), fetches live pricing via `claude -p --tools WebSearch --model <haiku> <prompt>` directly (not through the proxy) and merges results in: unchanged prices bump the `to` date; changed prices seal the old record and append a new one. On fetch failure, exits without touching any existing file. The JSONL format is `{provider, model_prefix, from, to, input, output, cache_read, cache_write, fetched_at}`.
- `parse_args()` — extracts `-o`/`--ollama-model`, `-l`/`--limit`, `-t`/`--tag`, `--last`, `--list-tags`, and `--pricing` from argv. Returns `(ollama_model, limit_usd, lookback_days, tags, list_tags, force_pricing, claude_args)`. Validates that `--limit` and `--last` are paired. `-t`/`--tag` can be given multiple times.
- `collect_tags()` — scans `.ddbya.d/usage-*.ddbya` in the current project and sibling directories (same scope as `BudgetChecker`), returning all unique tags found. Used by `--list-tags` for shell tab completion of `-t`/`--tag` values.
- `_sanitise_identity(s)` — lowercases s and collapses runs of non-`[a-z0-9._-]` chars to a single `-`. Returns `"anonymous"` if the result is empty.
- `_resolve_identity()` — determines the per-user identity string used in log filenames. Resolution order: `git config user.email` → `$USER` → UUID stored in `~/.config/ddbya/id` (generated on first call if absent).
- `_migrate_legacy_layout(project_dir, identity)` — idempotent startup migration. Moves `.token-usage.ddbya` → `.ddbya.d/usage-<identity>-<session>.ddbya` and `.pricing.ddbya` → `.ddbya.d/pricing.ddbya` if the legacy files exist at the project root. Prints one line to stderr per file moved.
- `_build_extra_upstreams()` — reads `ANTHROPIC_BEDROCK_BASE_URL` (or `ANTHROPIC_AWS_BASE_URL`), `ANTHROPIC_VERTEX_BASE_URL`, and `ANTHROPIC_FOUNDRY_BASE_URL` from the environment before they are overridden. Returns a path-prefix → upstream-info dict consumed by `ReverseProxy`. Only backends whose `*_BASE_URL` env var is already set (indicating the user has an LLM gateway configured) are included. Native-SDK backends (`CLAUDE_CODE_USE_BEDROCK` without a gateway URL) cannot be intercepted without a format-translation layer.
- `main()` — parses args, resolves identity and calls `_migrate_legacy_layout`, detects `-p`/`--print` for programmatic billing tagging, configures upstream (Ollama if `-o` set, otherwise `ANTHROPIC_BASE_URL` or default), calls `_build_extra_upstreams()` to snapshot pre-existing cloud-provider gateway URLs, calls `maybe_update_pricing` (before proxy start, so the fetch goes direct to Anthropic), starts proxy and (optionally) `BudgetChecker`. If `--list-tags` is given, prints collected tags and exits. Wires `BudgetChecker.on_exceeded → proxy.budget_exceeded.set`. Sets `ANTHROPIC_BASE_URL` and (for each detected backend) `ANTHROPIC_BEDROCK_BASE_URL` / `ANTHROPIC_VERTEX_BASE_URL` / `ANTHROPIC_FOUNDRY_BASE_URL` to path-prefixed proxy URLs so all configured backends route through the proxy. Runs `claude` via `subprocess.Popen` with inherited stdio. When a budget is set, a watchdog thread waits on `proxy.budget_exceeded`, then `proxy.wait_idle()`, then sends `SIGTERM` (escalating to `SIGKILL` after 30 s) so the model finishes any in-flight responses before claude exits. Prints session summary to stderr on exit.

## Token extraction

- Non-streaming: reads full response JSON, decompresses if gzipped, extracts `usage.input_tokens`, `usage.output_tokens`, `usage.cache_read_input_tokens`, `usage.cache_creation_input_tokens`.
- Streaming (SSE): incrementally decompresses gzip and parses events line-by-line as chunks arrive (no full-body buffer). Scans `message_start` (Anthropic input + cache fields at `message.usage.*`), `message_delta` (Ollama usage, Anthropic output tokens), and `message_stop` (fallback).
- `billing_mode` values: `anthropic_subscription` (Claude.ai OAuth Bearer token, all-you-can-eat), `anthropic_subscription_overage` (subscription tipped into pay-per-use), `anthropic_api` (Anthropic Console API key, always pay-per-use), `aws_bedrock` (AWS Bedrock via LLM gateway), `google_vertex` (Google Vertex AI via LLM gateway), `azure_foundry` (Microsoft Azure Foundry via LLM gateway), `ollama` (local Ollama instance), `ollama_subscription` (remote Ollama via model name ending in `:cloud`).
- **Cost attribution uses a deny-list approach** (`_FREE_BILLING_MODES` = `{"ollama", "ollama_subscription"}`): entries with a billing mode in that set cost $0; entries with `billing_mode=None` also cost $0 (unknown, cannot charge); entries with `billing_mode="anthropic_subscription"` cost $0 unless both `programmatic=True` and the timestamp is ≥ `SUBSCRIPTION_PROGRAMMATIC_BILLING_DATE`; all other billing modes — including any future ones not yet enumerated — are priced using Anthropic's published rates from the project-local `.ddbya.d/pricing.ddbya` (falling back to the hardcoded `MODEL_PRICING` constants). This ensures new paid billing modes are automatically chargeable without a code update.
- A `"tags"` list is written into every entry when `-t`/`--tag` is given at launch (can be given multiple times). Tags associate consumption with a purpose independently of the project folder.
- A `"programmatic": true` field is added when `-p`/`--print` is detected in claude args, to distinguish non-interactive usage for billing (relevant from 15 June 2026 Anthropic subscriptions).
- Anthropic's `usage.input_tokens` is the **non-cache** base input count — it does NOT include cache tokens. Total input = `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Source: [Anthropic SDK `Message.usage` docstring](https://raw.githubusercontent.com/anthropics/anthropic-sdk-python/main/src/anthropic/types/message.py) ("Total input tokens in a request is the summation of `input_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`").
- Prompt caching explains the large token-count difference between Anthropic (cached) and Ollama (uncached). Cache fields appear in the log only when non-zero.
- Anthropic streaming responses include a `rate_limit_event` SSE event (type `"rate_limit_event"`) on every subscription request. The overage flag is at `rate_limit_info.isUsingOverage`. When `true`, the subscription window is exhausted and billing has tipped to pay-per-use rates. `_relay_stream` captures this and logs `billing_mode: "anthropic_subscription_overage"` instead of `"anthropic_subscription"`. Both `BudgetChecker._entry_cost` and `ddbya-report.entry_cost` treat this value as chargeable. This detection only applies to streaming responses, which is what Claude Code uses in practice. Non-streaming subscription requests are always logged as `"anthropic_subscription"` regardless of overage state. Source: https://fazm.ai/t/how-does-claude-extra-usage-work
- `_detect_billing_mode` distinguishes API key from subscription Bearer tokens: `Bearer sk-ant-*` → `anthropic_api` (API key sent as Bearer); upstream not `api.anthropic.com` with any other Bearer → `anthropic_api` (enterprise gateway, not a claude.ai subscription endpoint); `Bearer <other>` on `api.anthropic.com` → `anthropic_subscription` (OAuth token). This covers both API keys mis-sent as Bearer and third-party enterprise gateways whose Bearer tokens are enterprise credentials rather than claude.ai OAuth.
- Timestamps are ISO 8601 UTC.

## No dependencies

Uses only Python 3 standard library: `http.server`, `http.client`, `urllib.parse`, `json`, `threading`, `subprocess`, `pathlib`, `signal`, `gzip`, `zlib`, `uuid`.

## Identity & layout

Each project stores all ddbya state in a `.ddbya.d/` subdirectory:

```
<project>/
  .ddbya.d/
    pricing.ddbya                          ← shared, committed; historical Anthropic prices
    usage-alice-example.com-3f2a1b9c.ddbya ← Alice's token log (one file per session)
    usage-alice-example.com-7d4e2a1f.ddbya ← Alice's second session
    usage-bob-example.com-9c8b5e3a.ddbya   ← Bob's token log
```

Per-session filenames use the pattern `usage-<identity>-<session>.ddbya`, where `<session>` is an 8-character random hex string (`uuid.uuid4().hex[:8]`) generated at startup. Each invocation of `ddbya` creates its own file, so parallel sessions from the same user never share a write target. Identity is resolved at startup via `_resolve_identity()`: `git config user.email` → `$USER` → UUID stored in `~/.config/ddbya/id`. The identity is sanitised to lowercase `[a-z0-9._-]` (any other character collapsed to `-`).

**Migration:** if a legacy `.token-usage.ddbya` or `.pricing.ddbya` exists at the project root, `_migrate_legacy_layout()` renames them into `.ddbya.d/` on the first ddbya run after the upgrade. The legacy usage file is attributed to the current user.

## Reporting

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects.

```
ddbya-report /path/to/projects [--last N | --today] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json | --csv]
```

- If the given folder directly contains a `.ddbya.d/` with usage files, reports on that project only. Otherwise scans subdirectories recursively for `.ddbya.d/usage-*.ddbya` files.
- Legacy `.token-usage.ddbya` files (not yet migrated) are also read as a fallback.
- Project name = top-level subfolder under the given root that contains the `.ddbya.d/` directory (first path component after root). If the directory is directly in root, uses root's directory name.
- Aggregates by project, model, programmatic flag, and tags (across all per-user files in the same project). A Tags column appears whenever any entry has tags.
- Includes all data by default. Pass `--last`, `--from`, `--to`, or `--today` to filter by date. `--today` is shorthand for `--from <today> --to <today>` and is mutually exclusive with `--last`, `--from`, and `--to`.
- `--from`/`--to` can be used together or individually; `--from` without `--to` means "from that date to now".
- `-t`/`--tag` filters to entries containing that tag. Can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. Example: `ddbya-report . -t /^Steve/ -t "code review"` matches entries whose tags include one starting with "Steve" AND one exactly "code review".
- `-t`/`--tag` with `+`/`-` prefix triggers retagging mode instead of reporting:
  - `-t +tagname` adds "tagname" to all matching entries.
  - `-t -tagname` removes "tagname" from all matching entries. Wrap in `/ /` for regex: `-t -/^Steve/`.
  - Retagging modifies `.ddbya.d/usage-*.ddbya` files in-place. Cannot be combined with `--json`/`--csv`.
  - Example: `ddbya-report . -t foobar -t +hello` adds "hello" to every entry that has tag "foobar".
- Zero dependencies — Python 3 standard library only.
- Pricing (`MODEL_PRICING`, `_DEFAULT_PRICING`, `_MODEL_PRICING_PREFIXES`, `SUBSCRIPTION_PROGRAMMATIC_BILLING_DATE`, `_FREE_BILLING_MODES`, `find_pricing_for`, `load_pricing_records`) is loaded at startup from the sibling `ddbya` file via `importlib.machinery.SourceFileLoader`, so the two scripts share a single source of truth. Both must be installed in the same directory. (`_EMBEDDED_PRICING_RECORDS` and `maybe_update_pricing` are not imported — they are only needed in `ddbya` itself.) Each project's `.ddbya.d/pricing.ddbya` is loaded per-project inside `collect_entries` and passed to `entry_cost` so historical rates apply correctly.

## Ollama support

The `-o`/`--ollama-model` flag auto-configures: upstream set to `http://<OLLAMA_HOST>` (default `127.0.0.1:11434`), `ANTHROPIC_AUTH_TOKEN=ollama`, `ANTHROPIC_API_KEY` removed from env, and `--model <model>` prepended to claude args.

## Maintenance

- When a new Claude Code version is released, verify that none of ddbya's own short flags (`-o`, `-l`, `-t`, `-p`) or long flags (`--ollama-model`, `--limit`, `--last`, `--tag`, `--list-tags`, `--pricing`) conflict with new flags introduced by Claude Code itself. A conflict would shadow or consume a flag meant for the wrapped `claude` process.

## Conventions

- British English spelling in all prose and identifiers.
- ISO 8601 UTC timestamps for logged data.
- `.ddbya.d/` is committed to this repository. `pricing.ddbya` inside it is the master pricing reference, used as the default when ddbya is deployed elsewhere. Per-user `usage-*.ddbya` files are also committed so consumption history is preserved in the repo.
