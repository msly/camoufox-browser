# camoufox-browser

Camoufox-backed browser automation CLI for AI agents.

Status: v0.1 “core drop-in” compatibility with `agent-browser` (core subset). Non-core commands return `Not yet implemented: <command>`.

## Install

```bash
npm i -g camoufox-browser

# Download Camoufox binaries (required before `open`)
camoufox-browser install

# Linux only: also install system libraries (uses sudo/root)
camoufox-browser install --with-deps
```

## Quickstart (snapshot → refs → interact)

```bash
camoufox-browser open https://example.com
camoufox-browser snapshot -i

# Click an element from the snapshot (refs look like [ref=e1])
camoufox-browser click @e1

camoufox-browser get url
camoufox-browser screenshot page.png
camoufox-browser close
```

## JSON mode

Use `--json` to get machine-friendly output:

```bash
camoufox-browser --json snapshot -i
camoufox-browser --json get title
```

## Sessions

Each session has its own long-lived daemon (browser instance). Use this to isolate runs:

```bash
camoufox-browser --session prod open https://example.com
camoufox-browser --session prod snapshot -i
camoufox-browser --session prod close
```

Environment variables:

- `CAMOUFOX_BROWSER_SESSION` (alias: `AGENT_BROWSER_SESSION`)
- `CAMOUFOX_BROWSER_SOCKET_DIR` (alias: `AGENT_BROWSER_SOCKET_DIR`)
- `CAMOUFOX_BROWSER_IDLE_TIMEOUT_MS` (alias: `AGENT_BROWSER_IDLE_TIMEOUT_MS`)

## Common flags (core)

- `--headed` / `CAMOUFOX_BROWSER_HEADED=1`
- `--debug` / `CAMOUFOX_BROWSER_DEBUG=1`
- `--profile <dir>`: persistent context (durable cookies/storage)
- `--state <path>`: load Playwright storageState on launch (ephemeral mode)
- `--proxy <url>` / `--proxy-bypass <list>`
- `--user-agent <ua>`
- `--args "<comma-or-newline-separated args>"`

Notes:

- `--headed` is applied at browser launch time. If a session already has a running headless browser, `open|goto|navigate` with `--headed` will relaunch the browser to apply headed mode (this may close existing tabs/pages for that session).

## Command reference (v0.1 core + high-frequency)

- Navigation: `open|goto|navigate`, `back`, `forward`, `reload`, `close`
- Tabs: `tab [new [url]|list|close [n]|<n>]`
- Frame: `frame <selector|main>` (alias: `frame main` → `mainframe`)
- Dialog: `dialog <accept|dismiss> [text]`
- Snapshot: `snapshot [-i] [-c] [-C] [--depth N] [--selector <css>]`
- Eval: `eval [-b|--base64] [--stdin] <script>`
- Interact: `click`, `dblclick`, `focus`, `fill`, `type`, `press`, `hover`, `check`, `uncheck`, `select`, `drag`, `upload`, `download`
- Keyboard: `keydown <key>`, `keyup <key>`, `keyboard <type|inserttext> <text>`
- Scroll: `scroll [direction] [amount] [--selector <css>]`, `scrollintoview <selector>`
- Get: `get url|title|text|html|value|attr|count|box|styles`
- Is: `is visible|enabled|checked <selector>`
- Wait: `wait <ms|selector|@ref>` or `wait --url <pattern>` / `wait --load <state>` / `wait --text <text>`
- Screenshot: `screenshot [selector|@ref] [path]` (also supports `--full-page`, `--format`, `--quality`)
- Debug: `console [--clear]`, `errors [--clear]`, `highlight <selector>`
- Storage: `cookies [get|set|clear]`, `storage <local|session> [get|set|clear] [key] [value]`

## Gap vs agent-browser

`camoufox-browser` focuses on a **high-frequency drop-in subset**. If you need full `agent-browser` functionality, use `agent-browser` directly.

Not yet implemented in `camoufox-browser` (non-exhaustive):

- Network tooling: `route`, `unroute`, `requests`, `responsebody`
- Locator helpers: `find`, `getbyrole`/`getbytext`/... and related subcommands (`nth`, etc.)
- State vault: `state save|load|list|show|clear|rename|clean`
- Recording / profiling: HAR/recording/profiler/screencast commands
- Misc: `pdf`, `clipboard`, touch/mouse low-level input, permissions/geolocation/media emulation, devtools inspect/pause, diff tools

## More examples

Snapshot scoped to a container:

```bash
camoufox-browser snapshot -i --selector "main"
```

Wait for a ref to become visible:

```bash
camoufox-browser wait @e1
```

Use a persistent profile directory:

```bash
camoufox-browser --profile ~/.camoufox-profile open https://example.com
```

Manage cookies and web storage:

```bash
camoufox-browser cookies
camoufox-browser cookies set sid abc --url https://example.com --httpOnly --secure
camoufox-browser storage local set theme dark
camoufox-browser storage local get theme
camoufox-browser storage local
```

## Why “npm package + Rust”?

Camoufox/Playwright execution is Node-based, but the CLI is shipped as a native Rust binary for:

- Faster cold-start per invocation (especially in agent loops)
- Easier distribution of a single executable per platform
- Keeping the Node daemon isolated as a long-lived process per session

If the native binary can’t be downloaded or executed, `camoufox-browser` falls back to a JS implementation (`dist/cli.js`).

## Troubleshooting

- If you see an error about missing `~/.cache/camoufox/version.json`, run `camoufox-browser install`.
- If you use `pnpm` and see `better-sqlite3` “Could not locate the bindings file”, run:
  - `pnpm -C camoufox-browser install`
  - `pnpm -C camoufox-browser rebuild better-sqlite3`
