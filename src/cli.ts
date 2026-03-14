#!/usr/bin/env node
/**
 * JS fallback CLI (used when the native Rust binary is unavailable).
 */

import * as net from "node:net";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";
import { ensureDaemonRunning } from "./daemon-client.js";
import { getPortForSession, getUnixSocketPath, isValidSessionName, isWindows } from "./ipc.js";

type Flags = {
  json: boolean;
  headed: boolean;
  debug: boolean;
  session?: string;
  headers?: string;
  executablePath?: string;
  profile?: string;
  state?: string;
  proxy?: string;
  proxyBypass?: string;
  args?: string;
  userAgent?: string;
};

// ---------------------------------------------------------------------------
// System dependencies (Linux)
// ---------------------------------------------------------------------------

const APT_DEPS = [
  "libxcb-shm0",
  "libx11-xcb1",
  "libx11-6",
  "libxcb1",
  "libxext6",
  "libxrandr2",
  "libxcomposite1",
  "libxcursor1",
  "libxdamage1",
  "libxfixes3",
  "libxi6",
  "libgtk-3-0",
  "libpangocairo-1.0-0",
  "libpango-1.0-0",
  "libatk1.0-0",
  "libcairo-gobject2",
  "libcairo2",
  "libgdk-pixbuf-2.0-0",
  "libxrender1",
  "libfreetype6",
  "libfontconfig1",
  "libdbus-1-3",
  "libnss3",
  "libnspr4",
  "libatk-bridge2.0-0",
  "libdrm2",
  "libxkbcommon0",
  "libatspi2.0-0",
  "libcups2",
  "libxshmfence1",
  "libgbm1"
];

const DNF_DEPS = [
  "nss",
  "nspr",
  "atk",
  "at-spi2-atk",
  "cups-libs",
  "libdrm",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "mesa-libgbm",
  "pango",
  "alsa-lib",
  "libxkbcommon",
  "libxcb",
  "libX11-xcb",
  "libX11",
  "libXext",
  "libXcursor",
  "libXfixes",
  "libXi",
  "gtk3",
  "cairo-gobject"
];

const YUM_DEPS = [
  "nss",
  "nspr",
  "atk",
  "at-spi2-atk",
  "cups-libs",
  "libdrm",
  "libXcomposite",
  "libXdamage",
  "libXrandr",
  "mesa-libgbm",
  "pango",
  "alsa-lib",
  "libxkbcommon"
];

function isRoot(): boolean {
  return typeof (process as any).getuid === "function" && (process as any).getuid() === 0;
}

function resolveAptLibasound(): string {
  try {
    execFileSync("dpkg", ["-l", "libasound2t64"], { stdio: "ignore" });
    return "libasound2t64";
  } catch {
    return "libasound2";
  }
}

function installSystemDeps(): void {
  if (os.platform() !== "linux") {
    process.stderr.write("[camoufox-browser] System dependencies are only needed on Linux, skipping.\n");
    return;
  }

  const sudo = isRoot() ? [] : ["sudo"];

  if (fs.existsSync("/usr/bin/apt-get")) {
    const deps = [...APT_DEPS, resolveAptLibasound()];
    execFileSync(sudo[0] || "apt-get", [...(sudo[0] ? ["apt-get"] : []), "update", "-y"], {
      stdio: "inherit"
    });
    execFileSync(sudo[0] || "apt-get", [...(sudo[0] ? ["apt-get"] : []), "install", "-y", ...deps], {
      stdio: "inherit"
    });
    return;
  }

  if (fs.existsSync("/usr/bin/dnf")) {
    execFileSync(sudo[0] || "dnf", [...(sudo[0] ? ["dnf"] : []), "install", "-y", ...DNF_DEPS], {
      stdio: "inherit"
    });
    return;
  }

  if (fs.existsSync("/usr/bin/yum")) {
    execFileSync(sudo[0] || "yum", [...(sudo[0] ? ["yum"] : []), "install", "-y", ...YUM_DEPS], {
      stdio: "inherit"
    });
    return;
  }

  throw new Error("Could not detect a supported package manager (apt-get, dnf, yum).");
}

function genId(): string {
  return `r${Math.floor(Date.now() % 1_000_000)}${Math.floor(Math.random() * 1000)}`;
}

function parseFlags(argv: string[]): { flags: Flags; args: string[] } {
  const flags: Flags = { json: false, headed: false, debug: false };
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--json":
        flags.json = true;
        break;
      case "--headed":
        flags.headed = true;
        break;
      case "--debug":
        flags.debug = true;
        break;
      case "--session":
        flags.session = argv[++i];
        break;
      case "--headers":
        flags.headers = argv[++i];
        break;
      case "--executable-path":
        flags.executablePath = argv[++i];
        break;
      case "--profile":
        flags.profile = argv[++i];
        break;
      case "--state":
        flags.state = argv[++i];
        break;
      case "--proxy":
        flags.proxy = argv[++i];
        break;
      case "--proxy-bypass":
        flags.proxyBypass = argv[++i];
        break;
      case "--args":
        flags.args = argv[++i];
        break;
      case "--user-agent":
        flags.userAgent = argv[++i];
        break;
      default:
        args.push(a);
        break;
    }
  }

  return { flags, args };
}

function normalizeUrl(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("about:") ||
    lower.startsWith("data:") ||
    lower.startsWith("file:")
  ) {
    return raw;
  }
  return `https://${raw}`;
}

function buildCommand(args: string[], flags: Flags): Record<string, unknown> {
  if (args.length === 0) {
    throw new Error("Missing command");
  }
  const cmd = args[0];
  const rest = args.slice(1);
  const id = genId();

  switch (cmd) {
    case "open":
    case "goto":
    case "navigate": {
      const url = rest[0];
      if (!url) throw new Error("Usage: camoufox-browser open <url>");
      const out: Record<string, unknown> = { id, action: "navigate", url: normalizeUrl(url) };
      if (flags.headers) {
        try {
          out.headers = JSON.parse(flags.headers);
        } catch {
          throw new Error(`Invalid JSON for --headers: ${flags.headers}`);
        }
      }
      return out;
    }
    case "back":
    case "forward":
    case "reload":
      return { id, action: cmd };
    case "snapshot": {
      const out: Record<string, unknown> = { id, action: "snapshot" };
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        switch (a) {
          case "-i":
          case "--interactive":
            out.interactive = true;
            break;
          case "-c":
          case "--compact":
            out.compact = true;
            break;
          case "-C":
          case "--cursor":
            out.cursor = true;
            break;
          case "-d":
          case "--depth": {
            const n = Number(rest[i + 1]);
            if (Number.isFinite(n)) out.maxDepth = n;
            i++;
            break;
          }
          case "-s":
          case "--selector":
            out.selector = rest[i + 1];
            i++;
            break;
          default:
            break;
        }
      }
      return out;
    }
    case "click": {
      const newTab = rest.includes("--new-tab");
      const selector = rest.find((a) => a !== "--new-tab");
      if (!selector) throw new Error("Usage: camoufox-browser click <selector> [--new-tab]");
      return { id, action: "click", selector, ...(newTab ? { newTab: true } : {}) };
    }
    case "fill": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser fill <selector> <text>");
      return { id, action: "fill", selector, value: rest.slice(1).join(" ") };
    }
    case "type": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser type <selector> <text>");
      return { id, action: "type", selector, text: rest.slice(1).join(" ") };
    }
    case "hover": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser hover <selector>");
      return { id, action: "hover", selector };
    }
    case "check": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser check <selector>");
      return { id, action: "check", selector };
    }
    case "uncheck": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser uncheck <selector>");
      return { id, action: "uncheck", selector };
    }
    case "select": {
      const selector = rest[0];
      const values = rest.slice(1);
      if (!selector || values.length === 0) {
        throw new Error("Usage: camoufox-browser select <selector> <value...>");
      }
      return { id, action: "select", selector, values: values.length === 1 ? values[0] : values };
    }
    case "press":
    case "key": {
      if (rest.length === 0) throw new Error("Usage: camoufox-browser press <key>");
      if (rest.length >= 2) return { id, action: "press", selector: rest[0], key: rest[1] };
      return { id, action: "press", key: rest[0] };
    }
    case "get": {
      const sub = rest[0];
      if (!sub) throw new Error("Usage: camoufox-browser get <url|title|text> [args...]");
      if (sub === "url") return { id, action: "url" };
      if (sub === "title") return { id, action: "title" };
      if (sub === "text") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get text <selector>");
        return { id, action: "gettext", selector };
      }
      throw new Error(`Unknown get subcommand: ${sub}`);
    }
    case "wait": {
      const u = rest.indexOf("--url");
      const u2 = rest.indexOf("-u");
      const urlIdx = u >= 0 ? u : u2;
      if (urlIdx >= 0) {
        const pattern = rest[urlIdx + 1];
        if (!pattern) throw new Error("Usage: camoufox-browser wait --url <pattern>");
        return { id, action: "waitforurl", url: pattern };
      }

      const l = rest.indexOf("--load");
      const l2 = rest.indexOf("-l");
      const loadIdx = l >= 0 ? l : l2;
      if (loadIdx >= 0) {
        const state = rest[loadIdx + 1];
        if (!state) throw new Error("Usage: camoufox-browser wait --load <state>");
        return { id, action: "waitforloadstate", state };
      }

      const t = rest.indexOf("--text");
      const t2 = rest.indexOf("-t");
      const textIdx = t >= 0 ? t : t2;
      if (textIdx >= 0) {
        const text = rest[textIdx + 1];
        if (!text) throw new Error("Usage: camoufox-browser wait --text <text>");
        const timeoutIdx = rest.indexOf("--timeout");
        const timeout = timeoutIdx >= 0 ? Number(rest[timeoutIdx + 1]) : undefined;
        return {
          id,
          action: "wait",
          text,
          ...(Number.isFinite(timeout) ? { timeout } : {})
        };
      }

      const first = rest[0];
      if (!first) throw new Error("Usage: camoufox-browser wait <selector|ms|--url|--load|--text>");
      const n = Number(first);
      if (Number.isFinite(n)) return { id, action: "wait", timeout: n };
      return { id, action: "wait", selector: first };
    }
    case "screenshot": {
      let fullPage = false;
      let format: string | undefined;
      let quality: number | undefined;
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "--full-page" || a === "-f") {
          fullPage = true;
          continue;
        }
        if (a === "--format") {
          format = rest[++i];
          continue;
        }
        if (a === "--quality") {
          quality = Number(rest[++i]);
          continue;
        }
        positionals.push(a);
      }

      let selector: string | undefined;
      let path: string | undefined;
      if (positionals.length >= 2) {
        selector = positionals[0];
        path = positionals[1];
      } else if (positionals.length === 1) {
        const one = positionals[0];
        const isRelativePath = one.startsWith("./") || one.startsWith("../");
        const looksSelector = !isRelativePath && (one.startsWith("@") || one.startsWith(".") || one.startsWith("#"));
        const hasExt =
          one.endsWith(".png") || one.endsWith(".jpg") || one.endsWith(".jpeg") || one.endsWith(".webp");
        if (looksSelector && !hasExt) selector = one;
        else path = one;
      }

      return {
        id,
        action: "screenshot",
        ...(fullPage ? { fullPage: true } : {}),
        ...(format ? { format } : {}),
        ...(Number.isFinite(quality) ? { quality } : {}),
        ...(selector ? { selector } : {}),
        ...(path ? { path } : {})
      };
    }
    case "close":
    case "quit":
    case "exit":
      return { id, action: "close" };
    default:
      return { id, action: cmd };
  }
}

async function sendCommand(session: string, command: Record<string, unknown>): Promise<any> {
  const payload = `${JSON.stringify(command)}\n`;

  const socket = await new Promise<net.Socket>((resolve, reject) => {
    if (isWindows) {
      const port = getPortForSession(session);
      const s = net.createConnection({ host: "127.0.0.1", port }, () => resolve(s));
      s.on("error", reject);
      return;
    }

    const sockPath = getUnixSocketPath(session);
    const s = net.createConnection(sockPath, () => resolve(s));
    s.on("error", reject);
  });

  socket.write(payload);

  const line = await new Promise<string>((resolve, reject) => {
    let buf = "";
    socket.on("data", (d) => {
      buf += d.toString();
      const idx = buf.indexOf("\n");
      if (idx >= 0) {
        const out = buf.slice(0, idx);
        socket.destroy();
        resolve(out);
      }
    });
    socket.on("error", reject);
    socket.on("close", () => {
      if (!buf.includes("\n")) reject(new Error("No response from daemon"));
    });
  });

  return JSON.parse(line);
}

function printResponse(resp: any): number {
  if (!resp || typeof resp !== "object") {
    process.stderr.write("Invalid response\n");
    return 1;
  }

  if (resp.success !== true) {
    process.stderr.write(`${resp.error || "Unknown error"}\n`);
    return 1;
  }

  const data = resp.data;
  if (!data || typeof data !== "object") return 0;

  if (typeof data.url === "string") {
    if (typeof data.title === "string") {
      process.stdout.write(`${data.title}\n  ${data.url}\n`);
      return 0;
    }
    process.stdout.write(`${data.url}\n`);
    return 0;
  }

  if (typeof data.snapshot === "string") {
    process.stdout.write(`${data.snapshot}\n`);
    return 0;
  }

  if (typeof data.text === "string") {
    process.stdout.write(`${data.text}\n`);
    return 0;
  }

  if (typeof data.title === "string") {
    process.stdout.write(`${data.title}\n`);
    return 0;
  }

  if (typeof data.path === "string") {
    process.stdout.write(`${data.path}\n`);
    return 0;
  }

  if ("closed" in data) {
    process.stdout.write("Browser closed\n");
    return 0;
  }

  return 0;
}

async function main(): Promise<number> {
  const { flags, args } = parseFlags(process.argv.slice(2));

  // Client-side: install (no daemon needed).
  if (args[0] === "install") {
    const withDeps = args.slice(1).includes("--with-deps");
    try {
      process.stderr.write("[camoufox-browser] Downloading Camoufox...\n");
      execFileSync("npx", ["camoufox-js", "fetch"], { stdio: "inherit" });
      if (withDeps) {
        process.stderr.write("[camoufox-browser] Installing Linux system dependencies...\n");
        installSystemDeps();
      }
      if (flags.json) {
        process.stdout.write(
          `${JSON.stringify({ success: true, data: { installed: true, withDeps } })}\n`
        );
      } else {
        process.stderr.write("[camoufox-browser] Install complete.\n");
      }
      return 0;
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (flags.json) {
        process.stdout.write(`${JSON.stringify({ success: false, error: message })}\n`);
      } else {
        process.stderr.write(`${message}\n`);
      }
      return 1;
    }
  }

  const session =
    flags.session ||
    process.env.CAMOUFOX_BROWSER_SESSION ||
    process.env.AGENT_BROWSER_SESSION ||
    "default";

  if (!isValidSessionName(session)) {
    process.stderr.write(`Invalid session name: ${session}\n`);
    return 1;
  }

  if (flags.headed) process.env.CAMOUFOX_BROWSER_HEADED = "1";
  if (flags.debug) process.env.CAMOUFOX_BROWSER_DEBUG = "1";
  if (flags.executablePath) process.env.CAMOUFOX_BROWSER_EXECUTABLE_PATH = flags.executablePath;
  if (flags.profile) process.env.CAMOUFOX_BROWSER_PROFILE = flags.profile;
  if (flags.state) process.env.CAMOUFOX_BROWSER_STATE = flags.state;
  if (flags.proxy) process.env.CAMOUFOX_BROWSER_PROXY = flags.proxy;
  if (flags.proxyBypass) process.env.CAMOUFOX_BROWSER_PROXY_BYPASS = flags.proxyBypass;
  if (flags.args) process.env.CAMOUFOX_BROWSER_ARGS = flags.args;
  if (flags.userAgent) process.env.CAMOUFOX_BROWSER_USER_AGENT = flags.userAgent;

  await ensureDaemonRunning(session);

  const command = buildCommand(args, flags);
  const resp = await sendCommand(session, command);

  if (flags.json) {
    process.stdout.write(`${JSON.stringify(resp)}\n`);
    return resp?.success === false ? 1 : 0;
  }

  return printResponse(resp);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err?.message ?? String(err)}\n`);
    process.exit(1);
  });
