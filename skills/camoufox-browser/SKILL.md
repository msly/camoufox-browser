---
name: camoufox-browser
description: Camoufox-backed browser automation CLI for AI agents. Core drop-in compatible with agent-browser (core + high-frequency).
allowed-tools: Bash(camoufox-browser:*)
---

# camoufox-browser

Use `camoufox-browser` when a site blocks standard Playwright/Chromium automation and you need **Camoufox (anti-detect Firefox)**, while keeping an **agent-browser-style snapshot/ref workflow**.

## Before you start

- If navigation fails with a Camoufox “not installed” error, run: `camoufox-browser install` (Linux: add `--with-deps` if needed).
- Prefer using a dedicated session per task to avoid cross-run state bleed: `--session <name>`.
- `--headed` is applied at browser launch time. If a session already has a running headless browser, running `--headed open|goto|navigate ...` will relaunch that session to apply headed mode (this may close existing pages/tabs for that session).

## Workflow

1. Open / navigate:
   - `camoufox-browser --session <s> open <url>`
2. Snapshot interactive elements and get deterministic refs:
   - `camoufox-browser --session <s> snapshot -i`
3. Interact using refs (preferred) or selectors:
   - `camoufox-browser --session <s> click @e1`
   - `camoufox-browser --session <s> fill @e2 "text"`
   - `camoufox-browser --session <s> type @e2 "more text"`
   - `camoufox-browser --session <s> press Enter`
4. Wait for UI to settle / navigation:
   - `camoufox-browser --session <s> wait 1000`
   - `camoufox-browser --session <s> wait --url "**/dashboard"`
5. Re-snapshot after page changes:
   - `camoufox-browser --session <s> snapshot -i`
6. Optional: capture evidence
   - `camoufox-browser --session <s> screenshot page.png`
7. Cleanup:
   - `camoufox-browser --session <s> close`

## High-frequency commands (drop-in)

- Tabs:
  - `camoufox-browser --session <s> tab new [url]`
  - `camoufox-browser --session <s> tab list` (or just `tab`)
  - `camoufox-browser --session <s> tab 2`
  - `camoufox-browser --session <s> tab close [index]`
- Evaluate JS:
  - `camoufox-browser --session <s> eval "document.title"`
  - `camoufox-browser --session <s> eval -b ZG9jdW1lbnQudGl0bGU=` (base64)
  - `cat script.js | camoufox-browser --session <s> eval --stdin`
- Scroll:
  - `camoufox-browser --session <s> scroll down 300`
  - `camoufox-browser --session <s> scroll --selector ".panel" down 500`
  - `camoufox-browser --session <s> scrollintoview @e1`
- Get / Is:
  - `camoufox-browser --session <s> get html @e1`
  - `camoufox-browser --session <s> get attr @e1 href`
  - `camoufox-browser --session <s> get count "a"`
  - `camoufox-browser --session <s> is visible @e1`
- Extra interact:
  - `camoufox-browser --session <s> dblclick @e1`
  - `camoufox-browser --session <s> focus @e2`
  - `camoufox-browser --session <s> drag @e1 @e2`
  - `camoufox-browser --session <s> upload "input[type=file]" ./a.png ./b.png`
  - `camoufox-browser --session <s> download "a.export" ./out/report.pdf`
- Frame + dialogs:
  - `camoufox-browser --session <s> frame "#my-iframe"`
  - `camoufox-browser --session <s> frame main`
  - `camoufox-browser --session <s> dialog accept "prompt text"`
  - `camoufox-browser --session <s> dialog dismiss`
- Debug helpers:
  - `camoufox-browser --session <s> console`
  - `camoufox-browser --session <s> console --clear`
  - `camoufox-browser --session <s> errors`
  - `camoufox-browser --session <s> highlight @e1`
- Cookies + storage:
  - `camoufox-browser --session <s> cookies`
  - `camoufox-browser --session <s> cookies set sid abc --url https://example.com --httpOnly --secure`
  - `camoufox-browser --session <s> cookies clear`
  - `camoufox-browser --session <s> storage local set theme dark`
  - `camoufox-browser --session <s> storage local get theme`
  - `camoufox-browser --session <s> storage local` (dump all)
- Keyboard:
  - `camoufox-browser --session <s> keydown Shift`
  - `camoufox-browser --session <s> keyboard type "Hello"`
  - `camoufox-browser --session <s> keyup Shift`

## Output guidance

- Use `--json` for programmatic parsing and for stable agent loops:
  - `camoufox-browser --json snapshot -i`
  - `camoufox-browser --json get title`
- If a command returns `Not yet implemented: <command>`, it’s outside the v0.1 core subset.
