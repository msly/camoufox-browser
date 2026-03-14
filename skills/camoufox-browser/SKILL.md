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

## Output guidance

- Use `--json` for programmatic parsing and for stable agent loops:
  - `camoufox-browser --json snapshot -i`
  - `camoufox-browser --json get title`
- If a command returns `Not yet implemented: <command>`, it’s outside the v0.1 core subset.
