# dolla-dolla-bill-y-all

It's easy to recognise the cost effectiveness of using modern AI vs, for example, coding by hand. That doesn't mean, however, that one can use it indiscriminately without keeping track of how many tokens they're burning. The features native of your cloud provider of choice - say, an Anthropic Claude subscription - won't always enable you to distinguish consumption between one project and another. This is particularly important when you need  to charge your clients fairly and proportionally to the use associated to their respective projects.

dolla-dolla-bill-y-all is a zero-dependency reverse proxy that intercepts Claude Code API calls to log token consumption. Every request is forwarded transparently — the tool adds no perceptible latency — while usage data is written to a project-local JSONL file for cost monitoring and analysis.

## Installation

```sh
# clone and link into your PATH
git clone https://github.com/giacecco/dolla-dolla-bill-y-all.git
ln -s "$(pwd)/dolla-dolla-bill-y-all/ddbya"* /usr/local/bin/
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

# Tags -- label consumption for cross-project tracking
ddbya -t "reviewing PR #123"
ddbya -t "client-acme" -t "urgent"   # multiple tags per session
```

With `-o`/`--ollama-model`, the wrapper automatically sets the upstream to `OLLAMA_HOST` (defaults to `127.0.0.1:11434`), configures Ollama auth, and passes `--model` to claude. Without `-o`, the wrapper respects your existing `ANTHROPIC_BASE_URL` and auto-detects HTTP vs HTTPS.

### Directory layout

`--limit` and `--tag` key off a simple directory convention: group each client's projects under a shared parent folder. `ddbya-report` is recursive instead, starting from any folder.

```
projects/                     ← cd here, run ddbya-report . # report all consumption, divided by clients vs internal  
├── clients/                  ← cd here, run ddbya-report . # report all consumption, divided by client
│   └─── client-acme/         ← cd here, run ddbya-report . # report all consumption for client-acme, divided by project
│   │  ├── web-frontend/      ← cd here, run ddbya -t "code review" # launch Claude Code in this project and tag consumption as "code review"
│   │  └── api-backend/       ← cd here, run ddbya --limit 20 --last 7 # launch Claude Code and limit spend to 20 USD for client-acme (not just api-backend) this week
│   └─── client-baker/
│      ├── mobile-app/
│      └── data-pipeline/
└── internal/
    └── dolla-dolla-bill-y-all/
```

- **Budget scope** — `--limit` scans the current project and its sibling directories under the same parent. Keep all of a client's projects in one folder and the budget cap applies to that client only.
- **Tags** — `-t` labels every entry in a session so `ddbya-report` can filter by tag later, even across projects in different parent / client folders, e.g. to see how many tokens I've spent on "code review" across all clients.
- **Reporting** — point `ddbya-report` at a parent folder to aggregate across all its sub-projects, or at a single project folder to isolate one.

## Budget limits

`-l`/`--limit <USD>` together with `--last <days>` puts a soft cap on spend across **all sibling projects under the parent directory**, computed from each project's `token-usage.jsonl` using public Anthropic per-model pricing.

Behaviour:

- **At launch:** if recent spend is already at or above the limit, ddbya refuses to start the session.
- **During the session:** spend is re-checked every minute. Warnings are printed to stderr when spend crosses 80%, 85%, 90%, and each integer percentage from 95% upwards (crossing, not landing — spend can jump several points between ticks). If a session starts already past one or more thresholds, a single warning is shown at the highest crossed threshold. Warnings are deferred while a request is in flight (claude's TUI would otherwise repaint over them) and flushed on the next tick where the proxy is idle.
- **Once 100% is crossed mid-session:** the proxy starts replying to any *new* API call with HTTP 429 (a synthetic Anthropic-style error). Already in-flight requests are allowed to complete normally. Once the in-flight count drops to zero, ddbya sends `SIGTERM` to claude, escalating to `SIGKILL` after 30s if needed.
- **Unrecognised models:** if your `token-usage.jsonl` history already mentions a Claude model ddbya doesn't know about (e.g. a release newer than this copy), the pre-flight check refuses to launch and points you at the latest version. If a new unknown model appears mid-session (a sibling project logging a release ddbya hasn't seen), ddbya warns, falls back to Sonnet pricing as an approximation, and exits with status 1 at the end of the session.
- **Not supported with `-o`/`--ollama-model`** (no public pricing for arbitrary Ollama models).

## Output

Every API call appends a line to `./token-usage.jsonl` in the current working directory (one file per project):

```json
{"input_tokens": 354, "cache_read_input_tokens": 27123, "model": "claude-opus-4-7", "output_tokens": 42, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

`cache_read_input_tokens` and `cache_creation_input_tokens` fields appear when prompt caching is in use (Anthropic API). Ollama has no caching, so its `input_tokens` counts everything — this is why DeepSeek shows 27k tokens and Anthropic shows 354.

When `-t`/`--tag` is used, entries include a `"tags"` list. Tags let you associate consumption with a purpose (e.g. a PR review, a client project, an experiment) independently of the folder the session ran in.

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
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json]
```

If the given folder directly contains a `token-usage.jsonl` file, it reports on that project only. Otherwise it recursively scans all subdirectories for `token-usage.jsonl` files. Groups usage by top-level subfolder, model, programmatic flag, and tags. Defaults to the last 7 days. `--from` and `--to` can be used together or individually; `--from` without `--to` means "from that date to now". `--last` is mutually exclusive with `--from`/`--to`. `-t`/`--tag` filters entries by tag; can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. `--json` outputs compact JSON to stdout instead of the table. Each row's `tags` is an array of strings. Zero dependencies — Python 3 standard library only.

Example filtering with both regex and literal matching:

```sh
ddbya-report . -t /^Steve/ -t "code review"
```

```
Token Usage Report — 2026-05-08 to 2026-05-14

Project                 Model                      Programmatic  Reqs  Input (base)  Cache Read  Cache Create  Total Input  Output Tokens  Cost (USD)  Tags
──────────────────────  ─────────────────────────  ────────────  ────  ────────────  ──────────  ────────────  ───────────  ─────────────  ──────────  ─────────────────────────────────────────────────
dolla-dolla-bill-y-all  claude-haiku-4-5-20251001  no               2           347           -             -          347             11       $0.00  code review | ddbya core dev | Steve's tags request
dolla-dolla-bill-y-all  claude-opus-4-7            no              10         1,043     509,891        70,391      581,325          7,025       $0.88  code review | ddbya core dev | Steve's tags request
(subtotal)                                                         12         1,390     509,891        70,391      581,672          7,036       $0.88

TOTAL                                                              12         1,390     509,891        70,391      581,672          7,036       $0.88
```

## Shell autocompletion

`ddbya` supports tab completion for `-t`/`--tag` values. When you type `ddbya -t <TAB>`, the shell suggests tags already used across your projects (same scope as budget tracking). Completion is case-insensitive — typing `code` will match tags named `Code Review`, `code writing`, etc.

**zsh** — symlink the completion file into a directory in your `fpath`:

```sh
mkdir -p ~/.zsh/completions
ln -s "$(pwd)/completions/_ddbya" ~/.zsh/completions/_ddbya
```

Then ensure your `~/.zshrc` has:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

**bash** — source the completion script in your `~/.bashrc`:

```sh
source /path/to/dolla-dolla-bill-y-all/completions/ddbya.bash
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

## Disclaimer

This software has not been thoroughly tested. It is provided in the hope that it will be useful, but without any warranty. Use at your own risk. The authors accept no liability for any consequences arising from its use, including but not limited to incorrect cost tracking, budget enforcement failures, or any other misbehaviour.

## Licence

MIT License

Copyright (c) 2026 Gianfranco Cecconi

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
