# dolla-dolla-bill-y-all

It's easy to recognise the cost effectiveness of using modern AI vs, for example, coding by hand. That doesn't mean, however, that one can use it indiscriminately without keeping track of how many tokens they're burning. The features native of your cloud provider of choice - say, an Anthropic Claude subscription - won't always enable you to distinguish consumption between one project and another. This is particularly important when you need  to charge your clients fairly and proportionally to the use associated to their respective projects.

dolla-dolla-bill-y-all is a zero-dependency reverse proxy that intercepts Claude Code API calls to log token consumption. Every request is forwarded transparently — the tool adds no perceptible latency — while usage data is written to a project-local JSONL file for cost monitoring and analysis.

## Installation

```sh
# clone and link into your PATH
git clone https://github.com/giacecco/dolla-dolla-bill-y-all.git
ln -s "$(pwd)/dolla-dolla-bill-y-all/ddbya" "$(pwd)/dolla-dolla-bill-y-all/ddbya-report" /usr/local/bin/
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

## Pricing accuracy

ddbya tracks Anthropic's pricing historically in a project-local `.pricing.ddbya` file. When reporting costs, each log entry is priced at the rate that applied on the day it was logged — not today's rate.

On startup, ddbya checks the age of `.pricing.ddbya`. If the data is absent or more than 30 days old, it asks:

```
ddbya: pricing data is 32 days old. Fetch updated pricing via Claude? [y/N]
```

Answering `y` runs a one-shot `claude -p` call (using Haiku — cheapest model, web search enabled) that fetches the current tariffs from `anthropic.com/pricing` and writes them to `.pricing.ddbya`. The prompt is skipped for non-interactive sessions (`-p`/`--print` or non-TTY stdin). To force a fetch regardless of age, pass `--pricing` at launch:

```sh
ddbya --pricing          # update pricing, then start the session
```

If the fetch fails or Claude returns unparseable output, ddbya falls back silently to the hardcoded `MODEL_PRICING` table built into the script. Historical entries already in `.pricing.ddbya` are never modified in that case.

`.pricing.ddbya` is project-local runtime data — it is listed in `.gitignore` and not committed.

## Budget limits

`-l`/`--limit <USD>` together with `--last <days>` puts a soft cap on spend across **all sibling projects under the parent directory**, computed from each project's `.token-usage.ddbya` using the historical pricing from `.pricing.ddbya` (or the built-in table as fallback).

Behaviour:

- **At launch:** if recent spend is already at or above the limit, ddbya refuses to start the session.
- **During the session:** spend is re-checked every minute. Warnings are printed to stderr when spend crosses 80%, 85%, 90%, and each integer percentage from 95% upwards (crossing, not landing — spend can jump several points between ticks). If a session starts already past one or more thresholds, a single warning is shown at the highest crossed threshold. Warnings are deferred while a request is in flight (claude's TUI would otherwise repaint over them) and flushed on the next tick where the proxy is idle.
- **Once 100% is crossed mid-session:** the proxy starts replying to any *new* API call with HTTP 429 (a synthetic Anthropic-style error). Already in-flight requests are allowed to complete normally. Once the in-flight count drops to zero, ddbya sends `SIGTERM` to claude, escalating to `SIGKILL` after 30s if needed.
- **Unrecognised models:** if your `.token-usage.ddbya` history already mentions a Claude model ddbya doesn't know about (e.g. a release newer than this copy), the pre-flight check refuses to launch and points you at the latest version. If a new unknown model appears mid-session (a sibling project logging a release ddbya hasn't seen), ddbya warns, falls back to Sonnet pricing as an approximation, and exits with status 1 at the end of the session.
- **Not supported with `-o`/`--ollama-model`** (no public pricing for arbitrary Ollama models).

## Output

Every API call appends a line to `./.token-usage.ddbya` in the current working directory (one file per project):

```json
{"input_tokens": 354, "cache_read_input_tokens": 27123, "model": "claude-opus-4-7", "output_tokens": 42, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

`cache_read_input_tokens` and `cache_creation_input_tokens` fields appear when prompt caching is in use (Anthropic API). Ollama has no caching, so its `input_tokens` counts everything — this is why DeepSeek shows 27k tokens and Anthropic shows 354.

When `-t`/`--tag` is used, entries include a `"tags"` list. Tags let you associate consumption with a purpose (e.g. a PR review, a client project, an experiment) independently of the folder the session ran in.

When Claude Code is invoked with `-p`/`--print` (non-interactive mode), entries include `"programmatic": true`. This matters because Anthropic subscriptions starting 15 June 2026 bill programmatic and interactive usage at different rates. The field lets you separate the two when analysing costs.

**Subscription "extra usage" is tracked.** When a subscription plan exhausts its included session or weekly allowance and tips into extra usage (billed at standard pay-per-use rates), ddbya detects the transition from the `rate_limit` SSE event that Anthropic includes in every streaming response. Affected entries are logged with `billing_mode: "anthropic_subscription_overage"` and counted toward budget limits and cost reports at standard pay-per-use rates. This works for streaming responses, which is what Claude Code uses exclusively.

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

`ddbya-report` aggregates `.token-usage.ddbya` files across multiple projects.

```sh
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json | --csv]
```

If the given folder directly contains a `.token-usage.ddbya` file, it reports on that project only. Otherwise it recursively scans all subdirectories for `.token-usage.ddbya` files. Groups usage by top-level subfolder, model, programmatic flag, and tags. Includes all data by default — pass `--last`, `--from`, or `--to` to filter by date. `--from` and `--to` can be used together or individually; `--from` without `--to` means "from that date to now". `--last` is mutually exclusive with `--from`/`--to`. `-t`/`--tag` filters entries by tag; can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. `--json` outputs compact JSON to stdout instead of the table. `--csv` outputs CSV with a header row. Each row's `tags` is an array of strings in JSON, or a pipe-joined string in CSV. `--json` and `--csv` are mutually exclusive. Zero dependencies — Python 3 standard library only.

Example — last 7 days of consumption for this project:

```sh
ddbya-report . --last 7
```

```
Token Usage Report — 2026-05-08 to 2026-05-14

Project                 Model                      Programmatic  Reqs  Input (base)  Cache Read  Cache Create  Total Input  Output Tokens  Cost (USD)  Tags
──────────────────────  ─────────────────────────  ────────────  ────  ────────────  ──────────  ────────────  ───────────  ─────────────  ──────────  ────────────────────────────────────────────────────
dolla-dolla-bill-y-all  claude-haiku-4-5-20251001  no              63        24,008      67,861        29,128      120,997          2,002       $0.08
dolla-dolla-bill-y-all  claude-haiku-4-5-20251001  no               4           702           -             -          702             28       $0.00  code review | ddbya core dev
dolla-dolla-bill-y-all  claude-haiku-4-5-20251001  no               2           347           -             -          347             11       $0.00  code review | ddbya core dev | Steve's tags request
dolla-dolla-bill-y-all  claude-opus-4-7            no             223        12,947  15,505,366       548,058   16,066,371        103,323      $13.83
dolla-dolla-bill-y-all  claude-opus-4-7            no              82         6,302   7,557,402       204,112    7,767,816         38,860       $6.06  code review | ddbya core dev
dolla-dolla-bill-y-all  claude-opus-4-7            no              10         1,043     509,891        70,391      581,325          7,025       $0.88  code review | ddbya core dev | Steve's tags request
dolla-dolla-bill-y-all  claude-sonnet-4-6          no             104         4,740   5,683,220       409,030    6,096,990         28,113       $3.67
dolla-dolla-bill-y-all  deepseek-v4-pro            no             247    14,400,948           -             -   14,400,948        115,927           -
dolla-dolla-bill-y-all  deepseek-v4-pro            no             181     7,945,181           -             -    7,945,181         51,676           -  code writing | ddbya core dev
dolla-dolla-bill-y-all  deepseek-v4-pro            no             114     7,256,808           -             -    7,256,808         29,236           -  code writing | ddbya core dev | Steve's tags request
(subtotal)                                                       1,030    29,653,026  29,323,740     1,260,719   60,237,485        376,201      $24.51

TOTAL                                                            1,030    29,653,026  29,323,740     1,260,719   60,237,485        376,201      $24.51
```

## Shell autocompletion

`ddbya` and `ddbya-report` support tab completion for `-t`/`--tag` values. When you type `ddbya -t <TAB>` or `ddbya-report <folder> -t <TAB>`, the shell suggests tags already used across your projects. Completion is case-insensitive — typing `code` will match tags named `Code Review`, `code writing`, etc.

**zsh** — symlink the completion files into a directory in your `fpath`:

```sh
mkdir -p ~/.zsh/completions
ln -s "$(pwd)/completions/_ddbya" ~/.zsh/completions/_ddbya
ln -s "$(pwd)/completions/_ddbya-report" ~/.zsh/completions/_ddbya-report
```

Then ensure your `~/.zshrc` has:

```zsh
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit
```

**bash** — source the completion scripts in your `~/.bashrc`:

```sh
source /path/to/dolla-dolla-bill-y-all/completions/ddbya.bash
source /path/to/dolla-dolla-bill-y-all/completions/ddbya-report.bash
```

## How it works

```
ddbya
  ├─ starts local reverse proxy on 127.0.0.1:<random-port>
  ├─ sets ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  ├─ runs claude (all args forwarded)
  ├─ proxy relays each request to the real upstream
  │   └─ parses usage from streaming (SSE) and non-streaming responses
  ├─ (with --limit) budget watchdog scans .token-usage.ddbya every minute
  │   ├─ warns at 80 / 85 / 90% and each integer % from 95–99
  │   └─ at 100%: refuses new requests with HTTP 429, then SIGTERMs claude once idle
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
