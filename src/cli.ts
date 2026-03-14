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

async function readAllStdin(): Promise<string> {
  return await new Promise((resolve, reject) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += String(chunk);
    });
    process.stdin.on("end", () => resolve(buf));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
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
    case "tab": {
      const sub = rest[0];
      if (sub === "new") {
        const out: Record<string, unknown> = { id, action: "tab_new" };
        if (rest[1]) out.url = rest[1];
        return out;
      }
      if (sub === "list") return { id, action: "tab_list" };
      if (sub === "close") {
        const index = rest[1] ? Number(rest[1]) : undefined;
        return {
          id,
          action: "tab_close",
          ...(Number.isFinite(index) ? { index } : {})
        };
      }
      if (sub && Number.isFinite(Number(sub))) {
        return { id, action: "tab_switch", index: Number(sub) };
      }
      return { id, action: "tab_list" };
    }
    case "frame": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser frame <selector|main>");
      if (selector === "main") return { id, action: "mainframe" };
      return { id, action: "frame", selector };
    }
    case "dialog": {
      const sub = rest[0];
      if (sub !== "accept" && sub !== "dismiss") {
        throw new Error("Usage: camoufox-browser dialog <accept|dismiss> [text]");
      }
      const promptText = rest[1];
      return { id, action: "dialog", response: sub, ...(promptText ? { promptText } : {}) };
    }
    case "console": {
      const clear = rest.includes("--clear");
      return { id, action: "console", clear };
    }
    case "errors": {
      const clear = rest.includes("--clear");
      return { id, action: "errors", clear };
    }
    case "highlight": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser highlight <selector>");
      return { id, action: "highlight", selector };
    }
    case "storage": {
      const type = rest[0];
      if (type !== "local" && type !== "session") {
        throw new Error("Usage: camoufox-browser storage <local|session> [get|set|clear] [key] [value]");
      }

      const op = rest[1] || "get";
      if (op === "set") {
        const key = rest[2];
        const value = rest[3];
        if (!key || value === undefined) {
          throw new Error(`Usage: camoufox-browser storage ${type} set <key> <value>`);
        }
        return { id, action: "storage_set", type, key, value };
      }
      if (op === "clear") {
        return { id, action: "storage_clear", type };
      }

      const key = rest[2];
      return { id, action: "storage_get", type, ...(key ? { key } : {}) };
    }
    case "cookies": {
      const op = rest[0] || "get";
      if (op === "set") {
        const name = rest[1];
        const value = rest[2];
        if (!name || value === undefined) {
          throw new Error(
            "Usage: camoufox-browser cookies set <name> <value> [--url <url>] [--domain <domain>] [--path <path>] [--httpOnly] [--secure] [--sameSite <Strict|Lax|None>] [--expires <timestamp>]"
          );
        }

        const cookie: Record<string, unknown> = { name, value };
        for (let i = 3; i < rest.length; ) {
          const a = rest[i];
          switch (a) {
            case "--url": {
              const v = rest[i + 1];
              if (!v) throw new Error("Usage: camoufox-browser cookies set ... --url <url>");
              cookie.url = v;
              i += 2;
              break;
            }
            case "--domain": {
              const v = rest[i + 1];
              if (!v) throw new Error("Usage: camoufox-browser cookies set ... --domain <domain>");
              cookie.domain = v;
              i += 2;
              break;
            }
            case "--path": {
              const v = rest[i + 1];
              if (!v) throw new Error("Usage: camoufox-browser cookies set ... --path <path>");
              cookie.path = v;
              i += 2;
              break;
            }
            case "--httpOnly":
              cookie.httpOnly = true;
              i += 1;
              break;
            case "--secure":
              cookie.secure = true;
              i += 1;
              break;
            case "--sameSite": {
              const v = rest[i + 1];
              if (v !== "Strict" && v !== "Lax" && v !== "None") {
                throw new Error("Usage: camoufox-browser cookies set ... --sameSite <Strict|Lax|None>");
              }
              cookie.sameSite = v;
              i += 2;
              break;
            }
            case "--expires": {
              const v = rest[i + 1];
              const n = v ? Number(v) : NaN;
              if (!Number.isFinite(n)) throw new Error("Usage: camoufox-browser cookies set ... --expires <timestamp>");
              cookie.expires = n;
              i += 2;
              break;
            }
            default:
              i += 1;
              break;
          }
        }

        return { id, action: "cookies_set", cookies: [cookie] };
      }
      if (op === "clear") {
        return { id, action: "cookies_clear" };
      }
      return { id, action: "cookies_get" };
    }
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
    case "eval": {
      const first = rest[0];
      const isBase64 = first === "-b" || first === "--base64";
      const isStdin = first === "--stdin";

      if (isStdin) {
        return { id, action: "evaluate", stdin: true };
      }

      const scriptRaw = (isBase64 ? rest.slice(1) : rest).join(" ");
      if (!scriptRaw.trim()) throw new Error("Usage: camoufox-browser eval [options] <script>");

      const script = isBase64 ? Buffer.from(scriptRaw, "base64").toString("utf8") : scriptRaw;
      return { id, action: "evaluate", script };
    }
    case "scroll": {
      const out: Record<string, unknown> = { id, action: "scroll" };
      let positionalIndex = 0;

      for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === "-s" || a === "--selector") {
          const sel = rest[i + 1];
          if (!sel) throw new Error("Usage: camoufox-browser scroll [direction] [amount] [--selector <sel>]");
          out.selector = sel;
          i++;
          continue;
        }
        if (a.startsWith("-")) continue;

        if (positionalIndex === 0) out.direction = a;
        if (positionalIndex === 1) {
          const n = Number(a);
          if (Number.isFinite(n)) out.amount = n;
        }
        positionalIndex++;
      }

      if (typeof out.direction !== "string") out.direction = "down";
      if (typeof out.amount !== "number") out.amount = 300;
      return out;
    }
    case "scrollintoview":
    case "scrollinto": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser scrollintoview <selector>");
      return { id, action: "scrollintoview", selector };
    }
    case "click": {
      const newTab = rest.includes("--new-tab");
      const selector = rest.find((a) => a !== "--new-tab");
      if (!selector) throw new Error("Usage: camoufox-browser click <selector> [--new-tab]");
      return { id, action: "click", selector, ...(newTab ? { newTab: true } : {}) };
    }
    case "dblclick": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser dblclick <selector>");
      return { id, action: "dblclick", selector };
    }
    case "focus": {
      const selector = rest[0];
      if (!selector) throw new Error("Usage: camoufox-browser focus <selector>");
      return { id, action: "focus", selector };
    }
    case "drag": {
      const source = rest[0];
      const target = rest[1];
      if (!source || !target) throw new Error("Usage: camoufox-browser drag <source> <target>");
      return { id, action: "drag", source, target };
    }
    case "upload": {
      const selector = rest[0];
      const files = rest.slice(1);
      if (!selector || files.length === 0) throw new Error("Usage: camoufox-browser upload <selector> <files...>");
      return { id, action: "upload", selector, files };
    }
    case "download": {
      const selector = rest[0];
      const path = rest[1];
      if (!selector || !path) throw new Error("Usage: camoufox-browser download <selector> <path>");
      return { id, action: "download", selector, path };
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
    case "keydown": {
      const key = rest[0];
      if (!key) throw new Error("Usage: camoufox-browser keydown <key>");
      return { id, action: "keydown", key };
    }
    case "keyup": {
      const key = rest[0];
      if (!key) throw new Error("Usage: camoufox-browser keyup <key>");
      return { id, action: "keyup", key };
    }
    case "keyboard": {
      const sub = rest[0];
      if (sub !== "type" && sub !== "inserttext" && sub !== "insertText") {
        throw new Error("Usage: camoufox-browser keyboard <type|inserttext> <text>");
      }
      const text = rest.slice(1).join(" ");
      if (!text.trim()) throw new Error(`Usage: camoufox-browser keyboard ${sub} <text>`);
      return {
        id,
        action: "keyboard",
        subaction: sub === "type" ? "type" : "insertText",
        text
      };
    }
    case "get": {
      const sub = rest[0];
      if (!sub) throw new Error("Usage: camoufox-browser get <text|html|value|attr|url|title|count|box|styles> [args...]");
      if (sub === "url") return { id, action: "url" };
      if (sub === "title") return { id, action: "title" };
      if (sub === "text") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get text <selector>");
        return { id, action: "gettext", selector };
      }
      if (sub === "html") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get html <selector>");
        return { id, action: "innerhtml", selector };
      }
      if (sub === "value") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get value <selector>");
        return { id, action: "inputvalue", selector };
      }
      if (sub === "attr") {
        const selector = rest[1];
        const attribute = rest[2];
        if (!selector || !attribute) throw new Error("Usage: camoufox-browser get attr <selector> <attribute>");
        return { id, action: "getattribute", selector, attribute };
      }
      if (sub === "count") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get count <selector>");
        return { id, action: "count", selector };
      }
      if (sub === "box") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get box <selector>");
        return { id, action: "boundingbox", selector };
      }
      if (sub === "styles") {
        const selector = rest[1];
        if (!selector) throw new Error("Usage: camoufox-browser get styles <selector>");
        return { id, action: "styles", selector };
      }
      throw new Error(`Unknown get subcommand: ${sub}`);
    }
    case "is": {
      const sub = rest[0];
      if (!sub) throw new Error("Usage: camoufox-browser is <visible|enabled|checked> <selector>");
      const selector = rest[1];
      if (!selector) throw new Error(`Usage: camoufox-browser is ${sub} <selector>`);
      if (sub === "visible") return { id, action: "isvisible", selector };
      if (sub === "enabled") return { id, action: "isenabled", selector };
      if (sub === "checked") return { id, action: "ischecked", selector };
      throw new Error(`Unknown is subcommand: ${sub}`);
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

  if (Array.isArray((data as any).messages)) {
    const messages = (data as any).messages as any[];
    for (const msg of messages) {
      const level = typeof msg?.type === "string" ? msg.type : "log";
      const text = typeof msg?.text === "string" ? msg.text : "";
      process.stdout.write(`[${level}] ${text}\n`);
    }
    return 0;
  }

  if (Array.isArray((data as any).errors)) {
    const errors = (data as any).errors as any[];
    for (const err of errors) {
      const message = typeof err?.message === "string" ? err.message : "";
      if (message) process.stdout.write(`${message}\n`);
    }
    return 0;
  }

  if ((data as any).cleared === true) {
    process.stdout.write("Cleared\n");
    return 0;
  }

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

  if (Array.isArray((data as any).tabs)) {
    const tabs = (data as any).tabs as any[];
    for (let i = 0; i < tabs.length; i++) {
      const tab = tabs[i] || {};
      const index = typeof tab.index === "number" ? tab.index : i;
      const title = typeof tab.title === "string" && tab.title.length > 0 ? tab.title : "Untitled";
      const url = typeof tab.url === "string" ? tab.url : "";
      const active = tab.active === true;
      const marker = active ? "->" : "  ";
      process.stdout.write(`${marker} [${index}] ${title} - ${url}\n`);
    }
    return 0;
  }

  if (Array.isArray((data as any).cookies)) {
    const cookies = (data as any).cookies as any[];
    for (const c of cookies) {
      const name = typeof c?.name === "string" ? c.name : "";
      const value = typeof c?.value === "string" ? c.value : "";
      if (name) process.stdout.write(`${name}=${value}\n`);
    }
    return 0;
  }

  if ((data as any).data && typeof (data as any).data === "object") {
    const formatted = JSON.stringify((data as any).data, null, 2);
    process.stdout.write(`${formatted}\n`);
    return 0;
  }

  if (typeof data.text === "string") {
    process.stdout.write(`${data.text}\n`);
    return 0;
  }

  if (typeof (data as any).html === "string") {
    process.stdout.write(`${(data as any).html}\n`);
    return 0;
  }

  if (typeof (data as any).value === "string") {
    process.stdout.write(`${(data as any).value}\n`);
    return 0;
  }

  if (typeof (data as any).count === "number") {
    process.stdout.write(`${(data as any).count}\n`);
    return 0;
  }

  if (typeof (data as any).visible === "boolean") {
    process.stdout.write(`${(data as any).visible}\n`);
    return 0;
  }
  if (typeof (data as any).enabled === "boolean") {
    process.stdout.write(`${(data as any).enabled}\n`);
    return 0;
  }
  if (typeof (data as any).checked === "boolean") {
    process.stdout.write(`${(data as any).checked}\n`);
    return 0;
  }

  if ("result" in (data as any)) {
    const formatted = JSON.stringify((data as any).result, null, 2);
    process.stdout.write(`${formatted}\n`);
    return 0;
  }

  if ("box" in (data as any)) {
    const formatted = JSON.stringify((data as any).box, null, 2);
    process.stdout.write(`${formatted}\n`);
    return 0;
  }

  if (Array.isArray((data as any).elements)) {
    const formatted = JSON.stringify((data as any).elements, null, 2);
    process.stdout.write(`${formatted}\n`);
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

  if (typeof (data as any).closed === "number" && typeof (data as any).remaining === "number") {
    process.stdout.write("Tab closed\n");
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
  if ((command as any).action === "evaluate" && (command as any).stdin === true) {
    (command as any).script = await readAllStdin();
    delete (command as any).stdin;
  }
  if (flags.headed) (command as any).headless = false;
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
