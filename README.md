# dolla-dolla-bill-y-all

It's easy to recognise the cost effectiveness of using modern AI vs, for example, coding by hand. That doesn't mean, however, that one can use it indiscriminately without keeping track of how many tokens they're burning. The features native of your cloud provider of choice - say, an Anthropic Claude subscription - won't always enable you to distinguish consumption between one project and another. This is particularly important when you need  to charge your clients fairly and proportionally to the use associated to their respective projects.

dolla-dolla-bill-y-all is a zero-dependency reverse proxy that intercepts Claude Code API calls to log token consumption. Every request is forwarded transparently — the tool adds no perceptible latency — while usage data is written to a project-local JSONL file for cost monitoring and analysis.

## Installation

```sh
# clone and link into your PATH
git clone https://github.com/giacecco/dolla-dolla-bill-y-all.git
ln -s "$(pwd)/dolla-dolla-bill-y-all/ddbya" /usr/local/bin/ddbya
```

Requires Python 3. No pip packages needed — standard library only.

## Usage

```sh
ddbya                        # interactive session, uses env ANTHROPIC_BASE_URL
ddbya -p "explain this PR"   # one-shot, prints token summary to stderr
ddbya --model sonnet         # any claude flags are forwarded

# Ollama -- one flag auto-configures everything
ddbya -o deepseek-v4-pro:cloud
ddbya -o deepseek-v4-pro:cloud -p "explain this"

# Budget limit -- refuse to launch / refuse new requests once exceeded
ddbya --limit 20 --last 7    # cap spend at $20 over the last 7 days
```

With `-o`/`--ollama-model`, the wrapper automatically sets the upstream to `OLLAMA_HOST` (defaults to `127.0.0.1:11434`), configures Ollama auth, and passes `--model` to claude. Without `-o`, the wrapper respects your existing `ANTHROPIC_BASE_URL` and auto-detects HTTP vs HTTPS.

## Budget limits

`-l`/`--limit <USD>` together with `--last <days>` puts a soft cap on spend across **all sibling projects under the parent directory**, computed from each project's `token-usage.jsonl` using public Anthropic per-model pricing.

Behaviour:

- **At launch:** if recent spend is already at or above the limit, ddbya refuses to start the session.
- **During the session:** spend is re-checked every minute. Warnings are printed to stderr at 80%, 85%, 90%, and from 95% upwards.
- **Once 100% is crossed mid-session:** the proxy starts replying to any *new* API call with HTTP 429 (a synthetic Anthropic-style error). Already in-flight requests are allowed to complete normally. Once the in-flight count drops to zero, ddbya sends `SIGTERM` to claude, escalating to `SIGKILL` after 30s if needed.
- **Unrecognised models:** if your `token-usage.jsonl` history mentions a Claude model ddbya doesn't know about (e.g. a release newer than this copy), ddbya warns, falls back to Sonnet pricing as an approximation, and exits with status 1 at the end of the session.
- **Not supported with `-o`/`--ollama-model`** (no public pricing for arbitrary Ollama models).

## Output

Every API call appends a line to `./token-usage.jsonl` in the current working directory (one file per project):

```json
{"input_tokens": 354, "cache_read_input_tokens": 27123, "model": "claude-opus-4-7", "output_tokens": 42, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

`cache_read_input_tokens` and `cache_creation_input_tokens` fields appear when prompt caching is in use (Anthropic API). Ollama has no caching, so its `input_tokens` counts everything — this is why DeepSeek shows 27k tokens and Anthropic shows 354.

When Claude Code is invoked with `-p`/`--print` (non-interactive mode), entries include `"programmatic": true`. This matters because Anthropic subscriptions starting 15 June 2026 bill programmatic and interactive usage at different rates. The field lets you separate the two when analysing costs.

Timestamps are ISO 8601 UTC — parseable natively by `datetime.fromisoformat()` (Python), `new Date()` (JavaScript), `time.Parse(time.RFC3339, …)` (Go), etc.

When the session ends, a summary is printed to stderr:

```
Session token usage:
  Requests:     3
  Input:        1,062 tokens
  Output:       1,578 tokens
  Cache read:   81,237 tokens
  Total:        83,877 tokens
```

## Reporting

`ddbya-report` aggregates `token-usage.jsonl` files across multiple projects.

```sh
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
```

If the given folder directly contains a `token-usage.jsonl` file, it reports on that project only. Otherwise it scans immediate subdirectories (one level deep) for `token-usage.jsonl` files. Groups usage by project, model, and programmatic flag, and prints a summary table. Defaults to the last 7 days. `--from` and `--to` can be used together or individually; `--from` without `--to` means "from that date to now". Zero dependencies — Python 3 standard library only.

## How it works

```
ddbya
  ├─ starts local reverse proxy on 127.0.0.1:<random-port>
  ├─ sets ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  ├─ runs claude (all args forwarded)
  ├─ proxy relays each request to the real upstream
  │   └─ parses usage from streaming (SSE) and non-streaming responses
  └─ on exit: prints summary, exits with claude's return code
```

Token extraction handles the Anthropic API (`message_start` for input tokens, `message_delta` for output tokens), Ollama (`message_delta` for both), and transparently decompresses gzip-encoded responses from both APIs.
