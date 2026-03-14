#!/usr/bin/env node

/**
 * Cross-platform CLI wrapper for camoufox-browser.
 *
 * Prefers the native Rust binary (downloaded by postinstall) for fast startup.
 * Falls back to the JS implementation (dist/cli.js) when the native binary is
 * missing or fails to execute.
 */

import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getBinaryName() {
  const os = platform();
  const cpuArch = arch();

  let osKey;
  switch (os) {
    case "darwin":
      osKey = "darwin";
      break;
    case "linux":
      osKey = "linux";
      break;
    case "win32":
      osKey = "win32";
      break;
    default:
      return null;
  }

  let archKey;
  switch (cpuArch) {
    case "x64":
    case "x86_64":
      archKey = "x64";
      break;
    case "arm64":
    case "aarch64":
      archKey = "arm64";
      break;
    default:
      return null;
  }

  const ext = os === "win32" ? ".exe" : "";
  return `camoufox-browser-${osKey}-${archKey}${ext}`;
}

function runJsFallback() {
  const cliPath = join(__dirname, "../dist/cli.js");
  const child = spawn("node", [cliPath, ...process.argv.slice(2)], {
    stdio: "inherit",
    windowsHide: false
  });
  child.on("close", (code) => process.exit(code ?? 0));
}

function main() {
  const binaryName = getBinaryName();
  if (!binaryName) {
    runJsFallback();
    return;
  }

  const binaryPath = join(__dirname, binaryName);
  if (!existsSync(binaryPath)) {
    runJsFallback();
    return;
  }

  if (platform() !== "win32") {
    try {
      accessSync(binaryPath, constants.X_OK);
    } catch {
      try {
        chmodSync(binaryPath, 0o755);
      } catch {
        runJsFallback();
        return;
      }
    }
  }

  const child = spawn(binaryPath, process.argv.slice(2), {
    stdio: "inherit",
    windowsHide: false
  });

  child.on("error", () => runJsFallback());
  child.on("close", (code) => process.exit(code ?? 0));
}

main();

