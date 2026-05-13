# dolla-dolla-bill-y-all

A zero-dependency reverse proxy that intercepts Claude Code API calls to log token consumption. Every request is forwarded transparently — the tool adds no perceptible latency — while usage data is written to a project-local JSONL file for cost monitoring and analysis.

## Installation

```sh
# clone and link into your PATH
git clone https://github.com/giacecco/dolla-dolla-bill-y-all.git
ln -s "$(pwd)/dolla-dolla-bill-y-all/dolladollabillyall" /usr/local/bin/dolladollabillyall
```

Requires Python 3. No pip packages needed — standard library only.

## Usage

```sh
dolladollabillyall                        # interactive session
dolladollabillyall -p "explain this PR"   # one-shot, prints token summary to stderr
dolladollabillyall --model sonnet         # any claude flags are forwarded
```

The wrapper respects your existing `ANTHROPIC_BASE_URL` — if you use Ollama or another proxy, it automatically detects HTTP vs HTTPS.

## Output

Every API call appends a line to `./token-usage.jsonl` in the current working directory (one file per project):

```json
{"endpoint": "v1/messages", "input_tokens": 27433, "model": "claude-sonnet-4-6", "output_tokens": 526, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

Timestamps are ISO 8601 UTC — parseable natively by `datetime.fromisoformat()` (Python), `new Date()` (JavaScript), `time.Parse(time.RFC3339, …)` (Go), etc.

When the session ends, a summary is printed to stderr:

```
Session token usage:
  Requests:  3
  Input:     82,299 tokens
  Output:    1,578 tokens
  Total:     83,877 tokens
```

## How it works

```
dolladollabillyall
  ├─ starts local reverse proxy on 127.0.0.1:<random-port>
  ├─ sets ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  ├─ runs claude (all args forwarded)
  ├─ proxy relays each request to the real upstream
  │   └─ parses usage from streaming (SSE) and non-streaming responses
  └─ on exit: prints summary, exits with claude's return code
```

Token extraction handles both the Anthropic API (`message_stop` events) and Ollama-compatible APIs (`message_delta` events).
