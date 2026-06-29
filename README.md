# dolla-dolla-bill-y-all

It's easy to recognise the cost effectiveness of using modern AI vs, for example, coding by hand. That doesn't mean, however, that one can use it indiscriminately without keeping track of how many tokens they're burning. The features native of your cloud provider of choice - say, an Anthropic Claude subscription - won't always enable you to distinguish consumption between one project and another. This is particularly important when you need to charge your clients fairly and proportionally to the use associated to their respective projects.

dolla-dolla-bill-y-all provides two complementary tools:

- **`ddbya`** — a zero-dependency Node.js CLI wrapper for Claude Code that logs token consumption per-project.
- **ddbya Desktop** — a macOS/Windows/Linux menu bar / tray app that intercepts Claude Desktop traffic the same way.

Both log to the same JSONL format and `ddbya-report` aggregates them all into one report.

## Installation

See [INSTALL.md](INSTALL.md).

## Usage — CLI (Claude Code)

```sh
ddbya                        # interactive session, uses env ANTHROPIC_BASE_URL
ddbya --model sonnet         # any claude flags are forwarded
ddbya --help                 # show ddbya-specific options

# Tags — label consumption for cross-project tracking
ddbya -t "reviewing PR #123"
ddbya -t "client-acme" -t "urgent"   # multiple tags per session
```

The wrapper respects your existing `ANTHROPIC_BASE_URL`.

## Usage — Desktop (Claude Desktop)

Launch **ddbya Desktop** from `/Applications` (or from the menu bar on subsequent uses). It:

1. Starts a local proxy and registers it with the OS so Claude Desktop uses it.
2. Intercepts all API traffic, logging tokens to `~/Library/Application Support/ddbya/Claude Desktop/.ddbya.d/`.
3. Provides a tray menu to **change tags**, **export a CSV report**, or **launch Claude Desktop**.

### Directory layout

`--tag` and reporting key off a simple directory convention: group each client's projects under a shared parent folder. `ddbya-report` is recursive, starting from any folder.

```
projects/                     ← cd here, run ddbya-report . # report all consumption
├── clients/
│   └─── client-acme/
│   │  ├── web-frontend/      ← cd here, run ddbya -t "code review"
│   │  └── api-backend/
│   └─── client-baker/
└── internal/
    └── dolla-dolla-bill-y-all/
```

- **Tags** — `-t` labels every entry in a session so `ddbya-report` can filter by tag later, even across projects in different parent / client folders.
- **Reporting** — point `ddbya-report` at a parent folder to aggregate across all its sub-projects, or at a single project folder to isolate one.

### Per-project credentials with direnv

Different projects or clients may require different `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, or Claude.ai subscription accounts. Use [direnv](https://direnv.net/) with a `.envrc` file at each project (or client) root to switch credentials automatically on `cd`:

```sh
# clients/client-acme/.envrc
export ANTHROPIC_API_KEY=sk-ant-...acme
export ANTHROPIC_BASE_URL=https://gateway.acme.example.com
```

You can also set default tags via `DDBYA_TAGS` (comma-separated):

```sh
# clients/client-acme/.envrc
export DDBYA_TAGS=client-acme
```

Tags passed with `-t` are appended to `DDBYA_TAGS`, so you can add session-specific tags on top:

```sh
ddbya -t "code review"   # session tagged: client-acme, code review
```

## Output

Every API call appends a line to `.ddbya.d/usage-<identity>-<session>.ddbya` in the current working directory (or to the Claude Desktop log directory for the desktop app). Each contributor writes to their own file, so parallel work and PR merges never conflict:

```json
{"input_tokens": 354, "cache_read_input_tokens": 27123, "output_tokens": 42, "stream": true, "timestamp": "2026-05-13T14:30:00Z"}
```

`cache_read_input_tokens` and `cache_creation_input_tokens` fields appear when prompt caching is active.

When `-t`/`--tag` is used, entries include a `"tags"` list.

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

`ddbya-report` aggregates `.ddbya.d/usage-*.ddbya` files across multiple projects. Claude Desktop consumption (from the desktop app) is **always included automatically** as a project named `*Claude Desktop*`.

```sh
ddbya-report --help
ddbya-report /path/to/projects [--last N] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [-t <tag> ...] [--json | --csv]
```

If the given folder directly contains a `.ddbya.d/` with usage files, it reports on that project only. Otherwise it recursively scans all subdirectories for `.ddbya.d/usage-*.ddbya` files. Groups usage by top-level subfolder and tags. Includes all data by default — pass `--last`, `--from`, or `--to` to filter by date. `-t`/`--tag` filters entries by tag; can be given multiple times (AND logic). Tags wrapped in `/ /` are treated as regex. `--json` outputs compact JSON. `--csv` outputs CSV. Zero dependencies — Node.js built-in modules only.

A spinner is shown on stderr while data is being read.

Example — last 7 days including Claude Desktop:

```sh
ddbya-report . --last 7
```

```
Token Usage Report — 2026-06-20 to 2026-06-27

Project                 Model              Reqs  Input (base)  Cache Read  Cache Create  Total Input  Output Tokens
──────────────────────  ─────────────────  ────  ────────────  ──────────  ────────────  ───────────  ─────────────
*Claude Desktop*        claude-sonnet-4-6    42         3,201     412,004        10,501      425,706         18,224
dolla-dolla-bill-y-all  claude-sonnet-4-6   382        29,237  28,813,849     1,260,719   30,103,805        283,038

TOTAL                                       424        32,438  29,225,853     1,271,220   30,529,511        301,262
```

### Retagging

You can add or remove tags from historical entries in-place:

```sh
ddbya-report . -t foobar -t +hello    # add "hello" to entries tagged "foobar"
ddbya-report . -t /^client/ -t -old   # remove "old" from entries with a "client-*" tag
```

Retagging also operates on Claude Desktop log entries.

## Shell autocompletion

`ddbya` and `ddbya-report` support tab completion for `-t`/`--tag` values. Tags from Claude Desktop logs are also included in completions.

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

### CLI

```
ddbya
  ├─ starts local reverse proxy on 127.0.0.1:<random-port>
  ├─ sets ANTHROPIC_BASE_URL=http://127.0.0.1:<port>
  ├─ runs claude (all args forwarded)
  ├─ proxy relays each request to the real upstream
  │   └─ parses usage from streaming (SSE) and non-streaming responses
  └─ on exit: prints summary, exits with claude's return code
```

### Desktop app

```
ddbya Desktop (tray app)
  ├─ starts local reverse proxy on 127.0.0.1:<persistent-port>
  ├─ registers proxy URL via launchctl setenv (macOS) / registry (Windows) / environment.d (Linux)
  │   └─ Claude Desktop picks this up on next launch
  ├─ logs token usage to ~/Library/Application Support/ddbya/Claude Desktop/.ddbya.d/ (macOS)
  │   %APPDATA%\ddbya\Claude Desktop\.ddbya.d\ (Windows)
  │   ~/.local/share/ddbya/Claude Desktop/.ddbya.d/ (Linux)
  ├─ tray menu: Change Tags / Export Report / Launch Claude Desktop / Quit
  └─ on quit: unregisters env var, stops proxy
```

Token extraction handles the Anthropic streaming format (`message_start` for input tokens, `message_delta` for output tokens). Gzip-encoded responses are decompressed transparently.

## Disclaimer

Consumption figures are indicative. ddbya intercepts what it can see — HTTP traffic through its proxy — but billing is determined by each provider's own systems and may include usage that never passes through ddbya (e.g. interactive Claude.ai web sessions, native-SDK calls that bypass the proxy, or provider-side rounding). Treat the numbers as a useful approximation for project attribution and cost awareness, not as an authoritative billing record.

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
