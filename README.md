# dolla-dolla-bill-y-all

It's easy to recognise the cost effectiveness of using modern AI vs, for example, coding by hand. That doesn't mean, however, that one can use it indiscriminately without keeping track of how many tokens they're burning. The features native of your cloud provider of choice - say, an Anthropic Claude subscription - won't always enable you to distinguish consumption between one project and another. This is particularly important when you need  to charge your clients fairly and proportionally to the use associated to their respective projects.

dolla-dolla-bill-y-all is a zero-dependency reverse proxy that intercepts Claude Code API calls to log token consumption. Every request is forwarded transparently — the tool adds no perceptible latency — while usage data is written to a project-local JSONL file for analysis.

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

# Tags -- label consumption for cross-project tracking
ddbya -t "reviewing PR #123"
ddbya -t "client-acme" -t "urgent"   # multiple tags per session
```

The wrapper respects your existing `ANTHROPIC_BASE_URL`. With `--deepseek`, the upstream is set to `DEEPSEEK_BASE_URL` (or the default DeepSeek endpoint) and every `DEEPSEEK_*` env var is mapped to its `ANTHROPIC_*` equivalent.

### Directory layout

`--tag` and reporting key off a simple directory convention: group each client's projects under a shared parent folder. `ddbya-report` is recursive, starting from any folder.

```
projects/                     ← cd here, run ddbya-report . # report all consumption, divided by clients vs internal  
├── clients/                  ← cd here, run ddbya-report . # report all consumption, divided by client
│   └─── client-acme/         ← cd here, run ddbya-report . # report all consumption for client-acme, divided by project
│   │  ├── web-frontend/      ← cd here, run ddbya -t "code review"
│   │  └── api-backend/       ← cd here, run ddbya -t "client-acme"
│   └─── client-baker/
│      ├── mobile-app/
│      └── data-pipeline/
└── internal/
    └── dolla-dolla-bill-y-all/
```

- **Tags** — `-t` labels every entry in a session so `ddbya-report` can filter by tag later, even across projects in different parent / client folders, e.g. to see how many tokens were spent on "code review" across all clients.
- **Reporting** — point `ddbya-report` at a parent folder to aggregate across all its sub-projects, or at a single project folder to isolate one.

## Cloud-provider backends

ddbya can intercept traffic to AWS Bedrock, Google Vertex AI, and Microsoft Azure Foundry when you have an LLM gateway already configured. Set the relevant base URL env var **before** launching ddbya:

```sh
# AWS Bedrock via LiteLLM or similar gateway
export ANTHROPIC_BEDROCK_BASE_URL=https://your-llm-gateway.example.com/bedrock
ddbya

# Google Vertex AI via gateway
export ANTHROPIC_VERTEX_BASE_URL=https://your-llm-gateway.example.com/vertex
ddbya
```

ddbya reads these URLs on startup, overrides them with proxy paths (`/--bedrock`, `/--vertex`, `/--foundry`), and routes each request to the original gateway.

**Limitation:** native-SDK backends (e.g. `CLAUDE_CODE_USE_BEDROCK=1` without a gateway URL) route through Claude Code's internal SDK and do not reach the proxy. ddbya cannot intercept those requests without a format-translation layer.

## Output

Every API call appends a line to `.ddbya.d/usage-<identity>.ddbya` in the current working directory, where `<identity>` is derived from `git config user.email` (or `$USER` as fallback). Each contributor writes to their own file, so parallel work and PR merges never conflict:

```json
{"input_tokens": 354, "cache_read_input_tokens": 27123, "output_tokens": 42, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

`cache_read_input_tokens` and `cache_creation_input_tokens` fields appear when prompt caching is in use (Anthropic API). DeepSeek has no caching, so its `input_tokens` counts everything.

When `-t`/`--tag` is used, entries include a `"tags"` list. Tags let you associate consumption with a purpose (e.g. a PR review, a client project, an experiment) independently of the folder the session ran in.

When Claude Code is invoked with `-p`/`--print` (non-interactive mode), entries include `"programmatic": true`.

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

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects (all contributors' files in each project are merged into a single project row).

```sh
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json | --csv]
```

If the given folder directly contains a `.ddbya.d/` with usage files, it reports on that project only. Otherwise it recursively scans all subdirectories for `.ddbya.d/usage-*.ddbya` files. Legacy `.token-usage.ddbya` files (not yet migrated) are also read as a fallback. Groups usage by top-level subfolder, programmatic flag, and tags. Includes all data by default — pass `--last`, `--from`, or `--to` to filter by date. `--from` and `--to` can be used together or individually; `--from` without `--to` means "from that date to now". `--last` is mutually exclusive with `--from`/`--to`. `-t`/`--tag` filters entries by tag; can be given multiple times (AND logic — an entry must match all filters). Tags wrapped in `/ /` are treated as regex; otherwise literal exact match. `--json` outputs compact JSON to stdout instead of the table. `--csv` outputs CSV with a header row. Each row's `tags` is an array of strings in JSON, or a pipe-joined string in CSV. `--json` and `--csv` are mutually exclusive. Zero dependencies — Python 3 standard library only.

Example — last 7 days of consumption for this project:

```sh
ddbya-report . --last 7
```

```
Token Usage Report — 2026-05-08 to 2026-05-14

Project                 Programmatic  Reqs  Input (base)  Cache Read  Cache Create  Total Input  Output Tokens  Tags
──────────────────────  ────────────  ────  ────────────  ──────────  ────────────  ───────────  ─────────────  ────────────────────────────────────────────────────
dolla-dolla-bill-y-all  no             382        29,237  28,813,849     1,260,719   30,103,805        283,038
dolla-dolla-bill-y-all  no             277        15,247     509,891        70,391      595,529         97,661  code review | ddbya core dev
dolla-dolla-bill-y-all  no             371        14,542           -             -       14,542         80,502  code writing | ddbya core dev
(subtotal)                           1,030        29,026  29,323,740     1,260,719   59,613,485        461,201

TOTAL                                1,030        29,026  29,323,740     1,260,719   59,613,485        461,201
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
  ├─ snapshots any existing ANTHROPIC_BEDROCK/VERTEX/FOUNDRY_BASE_URL
  ├─ starts local reverse proxy on 127.0.0.1:<random-port>
  ├─ sets ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  │   and (if backends found) ANTHROPIC_BEDROCK_BASE_URL=http://127.0.0.1:<port>/--bedrock etc.
  ├─ runs claude (all args forwarded)
  ├─ proxy relays each request to the real upstream
  │   ├─ path prefix /--bedrock → AWS Bedrock gateway
  │   ├─ path prefix /--vertex  → Vertex AI gateway
  │   ├─ path prefix /--foundry → Azure Foundry gateway
  │   └─ parses usage from streaming (SSE) and non-streaming responses
  └─ on exit: prints summary, exits with claude's return code
```

Token extraction handles the Anthropic API (`message_start` for input tokens, `message_delta` for output tokens) and DeepSeek's Anthropic-compatible streaming format. Gzip-encoded responses are decompressed transparently.

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
