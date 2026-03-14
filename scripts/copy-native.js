#!/usr/bin/env node

/**
 * Copies the compiled Rust binary to bin/ with platform-specific naming.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");
const binDir = join(projectRoot, "bin");

const ext = platform() === "win32" ? ".exe" : "";
const platformKey = `${platform()}-${arch()}`;

const sourcePath = join(projectRoot, "cli", "target", "release", `camoufox-browser${ext}`);
const targetName = `camoufox-browser-${platformKey}${ext}`;
const targetPath = join(binDir, targetName);

if (!existsSync(sourcePath)) {
  console.error(`Error: Native binary not found at ${sourcePath}`);
  console.error(`Build it with: cargo build --release --manifest-path cli/Cargo.toml`);
  process.exit(1);
}

if (!existsSync(binDir)) {
  mkdirSync(binDir, { recursive: true });
}

copyFileSync(sourcePath, targetPath);
console.log(`✓ Copied native binary to ${targetPath}`);

