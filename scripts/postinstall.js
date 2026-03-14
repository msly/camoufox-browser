#!/usr/bin/env node

/**
 * Postinstall script for camoufox-browser
 *
 * Downloads the platform-specific native binary if available.
 * If download fails, the package still works via JS fallback (dist/cli.js).
 */

import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync
} from "node:fs";
import { get } from "node:https";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const binDir = join(projectRoot, "bin");

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

function extractGitHubRepo(repositoryField) {
  const raw =
    typeof repositoryField === "string"
      ? repositoryField
      : repositoryField && typeof repositoryField.url === "string"
        ? repositoryField.url
        : "";

  const s = raw
    .replace(/^git\+/, "")
    .replace(/^ssh:\/\/git@github\.com\//, "https://github.com/")
    .replace(/^git@github\.com:/, "https://github.com/")
    .replace(/\.git$/, "");

  const m = s.match(/github\.com\/([^/]+\/[^/]+)$/);
  return m ? m[1] : null;
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest);

    const request = (u) => {
      get(u, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Failed to download: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      }).on("error", (err) => {
        try {
          unlinkSync(dest);
        } catch {}
        reject(err);
      });
    };

    request(url);
  });
}

function printBrowserReminder() {
  const message = `
+--------------------------------------------------------------+
|                                                              |
|   Run \`camoufox-browser install\` to download the browser.   |
|                                                              |
+--------------------------------------------------------------+
`;
  console.log(message);
}

async function main() {
  if (
    process.env.CAMOUFOX_BROWSER_SKIP_NATIVE_DOWNLOAD === "1" ||
    process.env.CAMOUFOX_BROWSER_SKIP_NATIVE_DOWNLOAD === "true"
  ) {
    console.log("camoufox-browser: Skipping native binary download (CAMOUFOX_BROWSER_SKIP_NATIVE_DOWNLOAD).");
    printBrowserReminder();
    return;
  }

  const binaryName = getBinaryName();
  if (!binaryName) {
    console.log("camoufox-browser: No native binary for this platform/arch; using JS fallback.");
    printBrowserReminder();
    return;
  }

  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true });
  }

  const binaryPath = join(binDir, binaryName);
  if (existsSync(binaryPath)) {
    if (platform() !== "win32") {
      try {
        chmodSync(binaryPath, 0o755);
      } catch {}
    }
    console.log(`✓ Native binary ready: ${binaryName}`);
    printBrowserReminder();
    return;
  }

  const pkg = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const version = pkg.version;
  const repo =
    process.env.CAMOUFOX_BROWSER_GITHUB_REPO ||
    extractGitHubRepo(pkg.repository) ||
    null;

  const baseUrl = process.env.CAMOUFOX_BROWSER_NATIVE_BASE_URL || null;

  const downloadUrl = baseUrl
    ? `${baseUrl.replace(/\/$/, "")}/v${version}/${binaryName}`
    : repo
      ? `https://github.com/${repo}/releases/download/v${version}/${binaryName}`
      : null;

  if (!downloadUrl) {
    console.log(
      "camoufox-browser: No native download source configured; skipping native binary download."
    );
    console.log("  Set CAMOUFOX_BROWSER_GITHUB_REPO=owner/repo or CAMOUFOX_BROWSER_NATIVE_BASE_URL=...");
    printBrowserReminder();
    return;
  }

  console.log(`Downloading native binary for ${platform()}-${arch()}...`);
  console.log(`URL: ${downloadUrl}`);

  try {
    await downloadFile(downloadUrl, binaryPath);
    if (platform() !== "win32") {
      chmodSync(binaryPath, 0o755);
    }
    console.log(`✓ Downloaded native binary: ${binaryName}`);
  } catch (err) {
    console.log(`⚠ Could not download native binary: ${err?.message ?? String(err)}`);
    console.log("  camoufox-browser will use JS fallback (slower startup)");
    console.log("  To build the native binary locally: npm run build:native");
  }

  printBrowserReminder();
}

main().catch((err) => {
  // Never fail installation due to postinstall issues.
  console.log(`⚠ camoufox-browser postinstall failed: ${err?.message ?? String(err)}`);
  printBrowserReminder();
});
