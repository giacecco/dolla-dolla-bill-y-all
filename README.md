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
```

With `-o`/`--ollama-model`, the wrapper automatically sets the upstream to `OLLAMA_HOST` (defaults to `127.0.0.1:11434`), configures Ollama auth, and passes `--model` to claude. Without `-o`, the wrapper respects your existing `ANTHROPIC_BASE_URL` and auto-detects HTTP vs HTTPS.

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
