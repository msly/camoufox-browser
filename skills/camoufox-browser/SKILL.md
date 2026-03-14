---
name: camoufox-browser
description: Camoufox-backed browser automation CLI for AI agents. Core drop-in compatible with agent-browser (WIP).
allowed-tools: Bash(camoufox-browser:*)
---

# camoufox-browser

Use `camoufox-browser` when a site blocks standard Playwright/Chromium automation and you need **Camoufox (anti-detect Firefox)**, while keeping an **agent-browser-style snapshot/ref workflow**.

## Before you start

- If navigation fails with a Camoufox “not installed” error, run: `camoufox-browser install` (Linux: add `--with-deps` if needed).
- Prefer using a dedicated session per task to avoid cross-run state bleed: `--session <name>`.

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

## Output guidance

- Use `--json` for programmatic parsing and for stable agent loops:
  - `camoufox-browser --json snapshot -i`
  - `camoufox-browser --json get title`
- If a command returns `Not yet implemented: <command>`, it’s outside the v0.1 core subset.
