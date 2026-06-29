# Installation

Download the latest release from the [GitHub releases page](https://github.com/giacecco/dolla-dolla-bill-y-all/releases).

> **Platform support:** macOS is the only platform with pre-built releases. Windows and Linux support exists in the source code but has not been tested and no binaries are provided.

## macOS

Install both the CLI tools and the desktop app. The CLI provides `ddbya` (Claude Code wrapper) and `ddbya-report` (terminal reporting); the desktop app intercepts Claude Desktop traffic and adds a tray icon.

### 1. CLI tools

Download `ddbya-cli-<version>.tar.gz` from the release, unpack it, and copy the files somewhere on your `PATH`:

```sh
tar xzf ddbya-cli-<version>.tar.gz
cp ddbya ddbya-report proxy-core.js report-core.js ~/.local/bin/
```

Requires Node.js. No npm packages needed — built-in modules only.

Optionally install shell completions — see [Shell autocompletion](README.md#shell-autocompletion).

### 2. ddbya Desktop

Download `ddbya-Desktop-<version>.zip` from the release, unzip it, and drag **ddbya Desktop** to `/Applications/`. Launch it from there — it will appear in the menu bar.

> **First-time setup:** after starting ddbya Desktop for the first time, quit and relaunch Claude Desktop so it picks up the proxy URL.
