import * as net from "node:net";
import * as fs from "node:fs";
import {
  cleanupIpcFiles,
  ensureSocketDir,
  getSocketDir,
  getPidFile,
  getPortFile,
  getPortForSession,
  getUnixSocketPath,
  isValidSessionName,
  isWindows
} from "./ipc.js";
import { errorResponse, parseCommand, serializeResponse, successResponse } from "./protocol.js";
import { BrowserManager, type LaunchConfig } from "./browser.js";
import type { Command, Response } from "./types.js";
import * as path from "node:path";
import * as fsPromises from "node:fs/promises";

/**
 * Backpressure-aware socket write.
 * If the kernel buffer is full, waits for 'drain' before resolving.
 */
async function safeWrite(socket: net.Socket, payload: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (socket.destroyed) return resolve();
    const ok = socket.write(payload);
    if (ok) return resolve();

    const cleanup = () => {
      socket.removeListener("drain", onDrain);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      resolve();
    };

    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function looksLikeHttp(line: string): boolean {
  return /^(GET|POST|PUT|DELETE|HEAD|OPTIONS|PATCH|CONNECT|TRACE)\s/i.test(line);
}

function getSession(): string {
  const raw =
    process.env.CAMOUFOX_BROWSER_SESSION || process.env.AGENT_BROWSER_SESSION || "default";
  if (!isValidSessionName(raw)) {
    throw new Error(`Invalid session name: ${raw}`);
  }
  return raw;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function getIdleTimeoutMs(): number {
  const raw =
    process.env.CAMOUFOX_BROWSER_IDLE_TIMEOUT_MS || process.env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_IDLE_TIMEOUT_MS;
  const val = parseInt(raw, 10);
  if (Number.isNaN(val)) return DEFAULT_IDLE_TIMEOUT_MS;
  return val;
}

export class DaemonServer {
  private readonly session: string;
  private readonly idleTimeoutMs: number;
  private readonly exitOnShutdown: boolean;
  private server: net.Server | null = null;
  private shuttingDown = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly browser = new BrowserManager();

  private readyResolve!: () => void;
  private readonly readyPromise: Promise<void>;

  constructor(opts?: { exitOnShutdown?: boolean }) {
    this.session = getSession();
    this.idleTimeoutMs = getIdleTimeoutMs();
    this.exitOnShutdown = opts?.exitOnShutdown ?? true;
    this.readyPromise = new Promise((resolve) => {
      this.readyResolve = resolve;
    });
  }

  async waitUntilReady(timeoutMs: number = 5000): Promise<void> {
    await Promise.race([
      this.readyPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error("Daemon did not become ready")), timeoutMs)
      )
    ]);
  }

  async start(): Promise<void> {
    ensureSocketDir();
    cleanupIpcFiles(this.session);

    fs.writeFileSync(getPidFile(this.session), String(process.pid));

    this.server = net.createServer((socket) => this.handleConnection(socket));

    this.server.on("error", (err) => {
      process.stderr.write(`[camoufox-browser] Server error: ${String(err)}\n`);
      this.shutdown(1).catch(() => {});
    });

    if (isWindows) {
      const port = getPortForSession(this.session);
      fs.writeFileSync(getPortFile(this.session), String(port));
      this.server.listen(port, "127.0.0.1", () => this.readyResolve());
    } else {
      const sockPath = getUnixSocketPath(this.session);
      this.server.listen(sockPath, () => this.readyResolve());
    }

    this.resetIdleTimer();

    if (this.exitOnShutdown) {
      const shutdown = async () => {
        await this.shutdown(0);
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
      process.on("SIGHUP", shutdown);
      process.on("exit", () => {
        cleanupIpcFiles(this.session);
      });
    }

    await new Promise<void>((resolve) => {
      this.server!.on("close", resolve);
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimeoutMs <= 0) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.shutdown(0).catch(() => {});
    }, this.idleTimeoutMs);
    if (this.idleTimer && typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      this.idleTimer.unref();
    }
  }

  private async shutdown(exitCode: number): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    if (this.server) {
      await new Promise<void>((resolve) => {
        try {
          this.server!.close(() => resolve());
        } catch {
          resolve();
        }
      });
      this.server = null;
    }

    cleanupIpcFiles(this.session);
    if (this.exitOnShutdown) {
      process.exit(exitCode);
    }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = "";
    let httpChecked = false;

    const commandQueue: string[] = [];
    let processing = false;

    const processQueue = async () => {
      if (processing) return;
      processing = true;

      while (commandQueue.length > 0) {
        const line = commandQueue.shift()!;
        this.resetIdleTimer();

        const parseResult = parseCommand(line);
        if (!parseResult.success) {
          const id = parseResult.id ?? "unknown";
          await safeWrite(socket, serializeResponse(errorResponse(id, parseResult.error)) + "\n");
          continue;
        }

        const cmd = parseResult.command;
        const response = await this.execute(cmd);
        await safeWrite(socket, serializeResponse(response) + "\n");

        if (cmd.action === "close") {
          setTimeout(() => {
            this.shutdown(0).catch(() => {});
          }, 100);
          commandQueue.length = 0;
          processing = false;
          return;
        }
      }

      processing = false;
    };

    socket.on("data", (data) => {
      buffer += data.toString();

      if (!httpChecked) {
        httpChecked = true;
        const trimmed = buffer.trimStart();
        if (looksLikeHttp(trimmed)) {
          socket.destroy();
          return;
        }
      }

      while (buffer.includes("\n")) {
        const newlineIdx = buffer.indexOf("\n");
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;
        commandQueue.push(line);
      }

      processQueue().catch((err) => {
        process.stderr.write(`[camoufox-browser] processQueue error: ${err?.message ?? String(err)}\n`);
      });
    });
  }

  private async execute(cmd: Command): Promise<Response> {
    try {
      if (cmd.action === "close") {
        await this.browser.close();
        return successResponse(cmd.id, { closed: true });
      }

      const needsBrowser =
        cmd.action === "launch" ||
        cmd.action === "navigate" ||
        cmd.action === "back" ||
        cmd.action === "forward" ||
        cmd.action === "reload" ||
        cmd.action === "tab_new" ||
        cmd.action === "tab_list" ||
        cmd.action === "tab_switch" ||
        cmd.action === "tab_close" ||
        cmd.action === "url" ||
        cmd.action === "title" ||
        cmd.action === "snapshot" ||
        cmd.action === "evaluate" ||
        cmd.action === "scroll" ||
        cmd.action === "scrollintoview" ||
        cmd.action === "click" ||
        cmd.action === "dblclick" ||
        cmd.action === "focus" ||
        cmd.action === "drag" ||
        cmd.action === "upload" ||
        cmd.action === "download" ||
        cmd.action === "frame" ||
        cmd.action === "mainframe" ||
        cmd.action === "dialog" ||
        cmd.action === "console" ||
        cmd.action === "errors" ||
        cmd.action === "highlight" ||
        cmd.action === "cookies_get" ||
        cmd.action === "cookies_set" ||
        cmd.action === "cookies_clear" ||
        cmd.action === "storage_get" ||
        cmd.action === "storage_set" ||
        cmd.action === "storage_clear" ||
        cmd.action === "fill" ||
        cmd.action === "type" ||
        cmd.action === "press" ||
        cmd.action === "keydown" ||
        cmd.action === "keyup" ||
        cmd.action === "keyboard" ||
        cmd.action === "hover" ||
        cmd.action === "check" ||
        cmd.action === "uncheck" ||
        cmd.action === "select" ||
        cmd.action === "gettext" ||
        cmd.action === "innerhtml" ||
        cmd.action === "inputvalue" ||
        cmd.action === "getattribute" ||
        cmd.action === "count" ||
        cmd.action === "boundingbox" ||
        cmd.action === "styles" ||
        cmd.action === "isvisible" ||
        cmd.action === "isenabled" ||
        cmd.action === "ischecked" ||
        cmd.action === "wait" ||
        cmd.action === "waitforurl" ||
        cmd.action === "waitforloadstate" ||
        cmd.action === "screenshot";

      const desiredHeadless =
        typeof (cmd as any).headless === "boolean" ? ((cmd as any).headless as boolean) : undefined;

      // Auto-launch on the first browser-dependent command for drop-in ergonomics.
      if (needsBrowser && !this.browser.isLaunched() && cmd.action !== "launch") {
        const cfgFromEnv = getLaunchConfigFromEnv();
        await this.browser.launch(
          desiredHeadless === undefined ? cfgFromEnv : { ...cfgFromEnv, headless: desiredHeadless }
        );
      }

      // If caller explicitly requests headless/headed, enforce it.
      // When a browser is already running with a different mode, we either:
      // - relaunch automatically for navigate/launch (since navigation will happen anyway), or
      // - return an actionable error for other commands to avoid surprising state loss.
      if (needsBrowser && desiredHeadless !== undefined && this.browser.isLaunched()) {
        const current = this.browser.getLaunchConfig();
        if (current && current.headless !== desiredHeadless) {
          if (cmd.action === "navigate" || cmd.action === "launch") {
            const relaunchCfg: LaunchConfig = { ...current, headless: desiredHeadless };
            await this.browser.close();
            await this.browser.launch(relaunchCfg);
          } else {
            if (envIsTruthy("CAMOUFOX_BROWSER_DEBUG") || envIsTruthy("AGENT_BROWSER_DEBUG")) {
              const currentMode = current.headless ? "headless" : "headed";
              const desiredMode = desiredHeadless ? "headless" : "headed";
              process.stderr.write(
                `[camoufox-browser] requested ${desiredMode} but session is already ${currentMode}; keeping existing browser. (Hint: run 'camoufox-browser close --session ${this.session}' to restart.)\n`
              );
            }
          }
        }
      }

      // Recover from stale state (launched but no pages).
      if (needsBrowser && this.browser.isLaunched() && !this.browser.hasPages() && cmd.action !== "launch") {
        await this.browser.ensurePage();
      }

      switch (cmd.action) {
        case "launch": {
          const cfgFromEnv = getLaunchConfigFromEnv();
          const override = coerceLaunchConfig(cmd);
          const cfg = override ? { ...cfgFromEnv, headless: override.headless } : cfgFromEnv;
          await this.browser.launch(cfg);
          return successResponse(cmd.id, { launched: true });
        }
        case "navigate": {
          const url = typeof cmd.url === "string" ? cmd.url : "";
          if (!url) return errorResponse(cmd.id, "Missing url");
          const waitUntil =
            cmd.waitUntil === "load" || cmd.waitUntil === "domcontentloaded" || cmd.waitUntil === "networkidle"
              ? (cmd.waitUntil as "load" | "domcontentloaded" | "networkidle")
              : undefined;
          const headers =
            cmd.headers && typeof cmd.headers === "object" && cmd.headers !== null ? (cmd.headers as Record<string, string>) : undefined;
          const result = await this.browser.navigate(url, { waitUntil, headers });
          return successResponse(cmd.id, result);
        }
        case "back": {
          const page = this.browser.getPage();
          await page.goBack();
          return successResponse(cmd.id, { url: page.url() });
        }
        case "forward": {
          const page = this.browser.getPage();
          await page.goForward();
          return successResponse(cmd.id, { url: page.url() });
        }
        case "reload": {
          const page = this.browser.getPage();
          await page.reload();
          return successResponse(cmd.id, { url: page.url() });
        }
        case "tab_new": {
          const result = await this.browser.newTabManaged();

          if (typeof cmd.url === "string" && cmd.url.length > 0) {
            const page = this.browser.getPage();
            await page.goto(cmd.url, { waitUntil: "domcontentloaded" });
          }

          return successResponse(cmd.id, result);
        }
        case "tab_list": {
          const tabs = await this.browser.listTabs();
          return successResponse(cmd.id, { tabs, active: this.browser.getActiveIndex() });
        }
        case "tab_switch": {
          const index = typeof (cmd as any).index === "number" ? ((cmd as any).index as number) : NaN;
          if (!Number.isFinite(index)) return errorResponse(cmd.id, "Missing index");
          const result = await this.browser.switchTo(index);
          const page = this.browser.getPage();
          return successResponse(cmd.id, { ...result, title: await page.title().catch(() => "") });
        }
        case "tab_close": {
          const rawIndex = (cmd as any).index;
          const index = typeof rawIndex === "number" ? (rawIndex as number) : undefined;
          const result = await this.browser.closeTab(index);
          return successResponse(cmd.id, result);
        }
        case "frame": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.switchToFrame({ selector });
          return successResponse(cmd.id, { switched: true });
        }
        case "mainframe": {
          this.browser.switchToMainFrame();
          return successResponse(cmd.id, { switched: true });
        }
        case "dialog": {
          const response =
            (cmd as any).response === "accept" || (cmd as any).response === "dismiss"
              ? ((cmd as any).response as "accept" | "dismiss")
              : null;
          if (!response) return errorResponse(cmd.id, "Missing response");
          const promptText = typeof (cmd as any).promptText === "string" ? ((cmd as any).promptText as string) : undefined;
          this.browser.setDialogHandler(response, promptText);
          return successResponse(cmd.id, { handler: "set", response });
        }
        case "url": {
          const page = this.browser.getPage();
          return successResponse(cmd.id, { url: page.url() });
        }
        case "title": {
          const page = this.browser.getPage();
          return successResponse(cmd.id, { title: await page.title() });
        }
        case "snapshot": {
          const interactive = typeof cmd.interactive === "boolean" ? cmd.interactive : undefined;
          const cursor = typeof cmd.cursor === "boolean" ? cmd.cursor : undefined;
          const compact = typeof cmd.compact === "boolean" ? cmd.compact : undefined;
          const selector = typeof cmd.selector === "string" ? cmd.selector : undefined;
          const maxDepth = typeof cmd.maxDepth === "number" ? cmd.maxDepth : undefined;
          const { tree, refs } = await this.browser.getSnapshot({
            interactive,
            cursor,
            compact,
            selector,
            maxDepth
          });

          const simpleRefs: Record<string, { role: string; name: string }> = {};
          for (const [ref, data] of Object.entries(refs)) {
            simpleRefs[ref] = { role: data.role, name: data.name };
          }

          const page = this.browser.getPage();
          return successResponse(cmd.id, {
            snapshot: tree || "Empty page",
            refs: Object.keys(simpleRefs).length > 0 ? simpleRefs : undefined,
            origin: page.url()
          });
        }
        case "console": {
          const clear = (cmd as any).clear === true;
          if (clear) {
            this.browser.clearConsoleMessages();
            return successResponse(cmd.id, { cleared: true });
          }
          const page = this.browser.getPage();
          const messages = this.browser.getConsoleMessages();
          return successResponse(cmd.id, { messages, origin: page.url() });
        }
        case "errors": {
          const clear = (cmd as any).clear === true;
          if (clear) {
            this.browser.clearPageErrors();
            return successResponse(cmd.id, { cleared: true });
          }
          const errors = this.browser.getPageErrors();
          return successResponse(cmd.id, { errors });
        }
        case "highlight": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).highlight();
          return successResponse(cmd.id, { highlighted: true });
        }
        case "cookies_get": {
          const page = this.browser.getPage();
          const context = page.context();
          const urlsRaw = (cmd as any).urls;
          const urls =
            Array.isArray(urlsRaw) && urlsRaw.every((u) => typeof u === "string") ? (urlsRaw as string[]) : undefined;
          const cookies = urls ? await context.cookies(urls) : await context.cookies();
          return successResponse(cmd.id, { cookies });
        }
        case "cookies_set": {
          const page = this.browser.getPage();
          const context = page.context();
          const cookiesRaw = (cmd as any).cookies;
          if (!Array.isArray(cookiesRaw) || cookiesRaw.length === 0) return errorResponse(cmd.id, "Missing cookies");

          const pageUrl = page.url();
          const cookies = cookiesRaw
            .filter(
              (c): c is Record<string, unknown> =>
                typeof c === "object" &&
                c !== null &&
                typeof (c as any).name === "string" &&
                typeof (c as any).value === "string"
            )
            .map((cookie) => {
              if (!(cookie as any).url && !(cookie as any).domain && !(cookie as any).path) {
                return { ...cookie, url: pageUrl };
              }
              return cookie;
            });

          if (cookies.length === 0) return errorResponse(cmd.id, "Missing cookies");
          await context.addCookies(cookies as any);
          return successResponse(cmd.id, { set: true });
        }
        case "cookies_clear": {
          const page = this.browser.getPage();
          const context = page.context();
          await context.clearCookies();
          return successResponse(cmd.id, { cleared: true });
        }
        case "storage_get": {
          const page = this.browser.getPage();
          const type = typeof (cmd as any).type === "string" ? ((cmd as any).type as string) : "";
          if (type !== "local" && type !== "session") return errorResponse(cmd.id, "Missing storage type");
          const storageType = type === "local" ? "localStorage" : "sessionStorage";
          const key = typeof (cmd as any).key === "string" ? ((cmd as any).key as string) : "";

          if (key) {
            const value = await page.evaluate(`${storageType}.getItem(${JSON.stringify(key)})`);
            return successResponse(cmd.id, { key, value });
          }

          const data = await page.evaluate(`
            (() => {
              const storage = ${storageType};
              const result = {};
              for (let i = 0; i < storage.length; i++) {
                const k = storage.key(i);
                if (k) result[k] = storage.getItem(k);
              }
              return result;
            })()
          `);
          return successResponse(cmd.id, { data });
        }
        case "storage_set": {
          const page = this.browser.getPage();
          const type = typeof (cmd as any).type === "string" ? ((cmd as any).type as string) : "";
          if (type !== "local" && type !== "session") return errorResponse(cmd.id, "Missing storage type");
          const storageType = type === "local" ? "localStorage" : "sessionStorage";
          const key = typeof (cmd as any).key === "string" ? ((cmd as any).key as string) : "";
          const value = typeof (cmd as any).value === "string" ? ((cmd as any).value as string) : "";
          if (!key) return errorResponse(cmd.id, "Missing key");

          await page.evaluate(`${storageType}.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`);
          return successResponse(cmd.id, { set: true });
        }
        case "storage_clear": {
          const page = this.browser.getPage();
          const type = typeof (cmd as any).type === "string" ? ((cmd as any).type as string) : "";
          if (type !== "local" && type !== "session") return errorResponse(cmd.id, "Missing storage type");
          const storageType = type === "local" ? "localStorage" : "sessionStorage";

          await page.evaluate(`${storageType}.clear()`);
          return successResponse(cmd.id, { cleared: true });
        }
        case "evaluate": {
          const page = this.browser.getPage();
          const script = typeof (cmd as any).script === "string" ? ((cmd as any).script as string) : "";
          if (!script) return errorResponse(cmd.id, "Missing script");
          const result = await page.evaluate(script);
          return successResponse(cmd.id, { result, origin: page.url() });
        }
        case "scroll": {
          const page = this.browser.getPage();
          const direction = typeof (cmd as any).direction === "string" ? ((cmd as any).direction as string) : "down";
          const amount = typeof (cmd as any).amount === "number" ? ((cmd as any).amount as number) : 300;
          const selector = typeof (cmd as any).selector === "string" ? ((cmd as any).selector as string) : undefined;

          let deltaX = 0;
          let deltaY = 0;
          switch (direction) {
            case "up":
              deltaY = -amount;
              break;
            case "down":
              deltaY = amount;
              break;
            case "left":
              deltaX = -amount;
              break;
            case "right":
              deltaX = amount;
              break;
            default:
              deltaY = amount;
              break;
          }

          if (selector) {
            const element = this.browser.getLocator(selector);
            await element.scrollIntoViewIfNeeded();
            await element.evaluate(
              (el, { x, y }) => {
                (el as any).scrollBy(x, y);
              },
              { x: deltaX, y: deltaY }
            );
          } else {
            await page.evaluate(`window.scrollBy(${deltaX}, ${deltaY})`);
          }

          return successResponse(cmd.id, { scrolled: true });
        }
        case "scrollintoview": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).scrollIntoViewIfNeeded();
          return successResponse(cmd.id, { scrolled: true });
        }
        case "click": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const locator = this.browser.getLocator(selector);

          if (cmd.newTab === true) {
            const fullUrl = await locator.evaluate((el) => {
              const href = (el as Element).getAttribute("href");
              return href ? new (globalThis as any).URL(href, (globalThis as any).document.baseURI).toString() : "";
            });
            if (!fullUrl) {
              return errorResponse(
                cmd.id,
                `Element '${selector}' does not have an href attribute. --new-tab only works on links.`
              );
            }

            await this.browser.newTab();
            const newPage = this.browser.getPage();
            await newPage.goto(fullUrl);
            return successResponse(cmd.id, { clicked: true, newTab: true, url: fullUrl });
          }

          await locator.click();
          return successResponse(cmd.id, { clicked: true });
        }
        case "dblclick": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).dblclick();
          return successResponse(cmd.id, { clicked: true });
        }
        case "focus": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).focus();
          return successResponse(cmd.id, { focused: true });
        }
        case "drag": {
          const source = typeof (cmd as any).source === "string" ? ((cmd as any).source as string) : "";
          const target = typeof (cmd as any).target === "string" ? ((cmd as any).target as string) : "";
          if (!source || !target) return errorResponse(cmd.id, "Missing source/target");
          await this.browser.getLocator(source).dragTo(this.browser.getLocator(target));
          return successResponse(cmd.id, { dragged: true });
        }
        case "upload": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const filesRaw = (cmd as any).files;
          const files =
            typeof filesRaw === "string"
              ? [filesRaw]
              : Array.isArray(filesRaw) && filesRaw.every((f) => typeof f === "string")
                ? (filesRaw as string[])
                : [];
          if (files.length === 0) return errorResponse(cmd.id, "Missing files");
          await this.browser.getLocator(selector).setInputFiles(files);
          return successResponse(cmd.id, { uploaded: files });
        }
        case "download": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const outPath = typeof (cmd as any).path === "string" ? ((cmd as any).path as string) : "";
          if (!outPath) return errorResponse(cmd.id, "Missing path");

          const page = this.browser.getPage();
          const locator = this.browser.getLocator(selector);

          await fsPromises.mkdir(path.dirname(outPath), { recursive: true });

          const [download] = await Promise.all([page.waitForEvent("download"), locator.click()]);
          await download.saveAs(outPath);

          return successResponse(cmd.id, {
            path: outPath,
            suggestedFilename: download.suggestedFilename()
          });
        }
        case "fill": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const value = typeof cmd.value === "string" ? cmd.value : "";
          await this.browser.getLocator(selector).fill(value);
          return successResponse(cmd.id, { filled: true });
        }
        case "type": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const text = typeof cmd.text === "string" ? cmd.text : "";
          await this.browser.getLocator(selector).pressSequentially(text);
          return successResponse(cmd.id, { typed: true });
        }
        case "press": {
          const key = typeof cmd.key === "string" ? cmd.key : "";
          if (!key) return errorResponse(cmd.id, "Missing key");

          if (typeof cmd.selector === "string" && cmd.selector.length > 0) {
            await this.browser.getLocator(cmd.selector).press(key);
          } else {
            await this.browser.getPage().keyboard.press(key);
          }
          return successResponse(cmd.id, { pressed: true });
        }
        case "keydown": {
          const key = typeof cmd.key === "string" ? cmd.key : "";
          if (!key) return errorResponse(cmd.id, "Missing key");
          const page = this.browser.getPage();
          await page.keyboard.down(key);
          return successResponse(cmd.id, { down: true, key });
        }
        case "keyup": {
          const key = typeof cmd.key === "string" ? cmd.key : "";
          if (!key) return errorResponse(cmd.id, "Missing key");
          const page = this.browser.getPage();
          await page.keyboard.up(key);
          return successResponse(cmd.id, { up: true, key });
        }
        case "keyboard": {
          const page = this.browser.getPage();
          const subaction =
            typeof (cmd as any).subaction === "string" ? (((cmd as any).subaction as string) || "type") : "type";
          const text = typeof (cmd as any).text === "string" ? ((cmd as any).text as string) : "";

          if (subaction === "type") {
            await page.keyboard.type(text);
            return successResponse(cmd.id, { typed: true, text });
          }
          if (subaction === "insertText") {
            await page.keyboard.insertText(text);
            return successResponse(cmd.id, { inserted: true, text });
          }

          return errorResponse(cmd.id, `Unknown keyboard subaction: ${subaction}`);
        }
        case "hover": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).hover();
          return successResponse(cmd.id, { hovered: true });
        }
        case "check": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).check();
          return successResponse(cmd.id, { checked: true });
        }
        case "uncheck": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          await this.browser.getLocator(selector).uncheck();
          return successResponse(cmd.id, { checked: false });
        }
        case "select": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const valuesRaw = (cmd as { values?: unknown }).values;
          if (typeof valuesRaw === "string") {
            await this.browser.getLocator(selector).selectOption(valuesRaw);
          } else if (Array.isArray(valuesRaw) && valuesRaw.every((v) => typeof v === "string")) {
            await this.browser.getLocator(selector).selectOption(valuesRaw as string[]);
          } else {
            return errorResponse(cmd.id, "Missing values");
          }
          return successResponse(cmd.id, { selected: true });
        }
        case "gettext": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const page = this.browser.getPage();
          const locator = this.browser.getLocator(selector);
          const inner = await locator.innerText();
          const text = inner || (await locator.textContent()) || "";
          return successResponse(cmd.id, { text, origin: page.url() });
        }
        case "innerhtml": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const page = this.browser.getPage();
          const html = await this.browser.getLocator(selector).innerHTML();
          return successResponse(cmd.id, { html, origin: page.url() });
        }
        case "inputvalue": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const page = this.browser.getPage();
          const value = await this.browser.getLocator(selector).inputValue();
          return successResponse(cmd.id, { value, origin: page.url() });
        }
        case "getattribute": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const attribute =
            typeof (cmd as any).attribute === "string" ? ((cmd as any).attribute as string) : "";
          if (!attribute) return errorResponse(cmd.id, "Missing attribute");
          const page = this.browser.getPage();
          const value = await this.browser.getLocator(selector).getAttribute(attribute);
          return successResponse(cmd.id, { attribute, value, origin: page.url() });
        }
        case "count": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const count = await this.browser.getLocator(selector).count();
          return successResponse(cmd.id, { count });
        }
        case "boundingbox": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const box = await this.browser.getLocator(selector).boundingBox();
          return successResponse(cmd.id, { box });
        }
        case "styles": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const page = this.browser.getPage();

          const extractStylesScript = `(function(el) {
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              text: (el.innerText || '').trim().slice(0, 80) || null,
              box: {
                x: Math.round(r.x),
                y: Math.round(r.y),
                width: Math.round(r.width),
                height: Math.round(r.height),
              },
              styles: {
                fontSize: s.fontSize,
                fontWeight: s.fontWeight,
                fontFamily: (s.fontFamily || '').split(',')[0].trim().replace(/\"/g, ''),
                color: s.color,
                backgroundColor: s.backgroundColor,
                borderRadius: s.borderRadius,
                border: s.border !== 'none' && s.borderWidth !== '0px' ? s.border : null,
                boxShadow: s.boxShadow !== 'none' ? s.boxShadow : null,
                padding: s.padding,
              },
            };
          })`;

          const refLocator = this.browser.getLocatorFromRef(selector);
          if (refLocator) {
            const element = await refLocator.evaluate((el, script) => {
              const fn = eval(script as string);
              return fn(el);
            }, extractStylesScript);
            return successResponse(cmd.id, { elements: [element] });
          }

          const elements = await page.$$eval(
            selector,
            (els, script) => {
              const fn = eval(script as string);
              return (els as any[]).map((el) => fn(el));
            },
            extractStylesScript
          );

          return successResponse(cmd.id, { elements });
        }
        case "isvisible": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const visible = await this.browser.getLocator(selector).isVisible();
          return successResponse(cmd.id, { visible });
        }
        case "isenabled": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const enabled = await this.browser.getLocator(selector).isEnabled();
          return successResponse(cmd.id, { enabled });
        }
        case "ischecked": {
          const selector = typeof cmd.selector === "string" ? cmd.selector : "";
          if (!selector) return errorResponse(cmd.id, "Missing selector");
          const checked = await this.browser.getLocator(selector).isChecked();
          return successResponse(cmd.id, { checked });
        }
        case "wait": {
          const page = this.browser.getPage();
          const frame = this.browser.getFrame();
          const timeout = typeof cmd.timeout === "number" ? cmd.timeout : undefined;

          if (typeof cmd.text === "string" && cmd.text.length > 0) {
            await page.waitForFunction(
              `(document.body && (document.body.innerText || '')).includes(${JSON.stringify(cmd.text)})`,
              { timeout }
            );
            return successResponse(cmd.id, { waited: true });
          }

          if (typeof cmd.selector === "string" && cmd.selector.length > 0) {
            const state =
              cmd.state === "attached" || cmd.state === "detached" || cmd.state === "visible" || cmd.state === "hidden"
                ? (cmd.state as "attached" | "detached" | "visible" | "hidden")
                : "visible";

            const locator = this.browser.getLocatorFromRef(cmd.selector);
            if (locator) {
              await locator.waitFor({ state, timeout });
            } else {
              await frame.waitForSelector(cmd.selector, { state, timeout });
            }
            return successResponse(cmd.id, { waited: true });
          }

          if (timeout !== undefined) {
            await page.waitForTimeout(timeout);
            return successResponse(cmd.id, { waited: true });
          }

          await page.waitForLoadState("load");
          return successResponse(cmd.id, { waited: true });
        }
        case "waitforurl": {
          const page = this.browser.getPage();
          const url = typeof cmd.url === "string" ? cmd.url : "";
          if (!url) return errorResponse(cmd.id, "Missing url");
          const timeout = typeof cmd.timeout === "number" ? cmd.timeout : undefined;
          await page.waitForURL(url, { timeout });
          return successResponse(cmd.id, { url: page.url() });
        }
        case "waitforloadstate": {
          const page = this.browser.getPage();
          const state = typeof cmd.state === "string" ? cmd.state : "";
          if (!state) return errorResponse(cmd.id, "Missing state");
          const timeout = typeof cmd.timeout === "number" ? cmd.timeout : undefined;
          await page.waitForLoadState(state as any, { timeout });
          return successResponse(cmd.id, { state });
        }
        case "screenshot": {
          const page = this.browser.getPage();

          const selector = typeof cmd.selector === "string" ? cmd.selector : undefined;
          const fullPage = cmd.fullPage === true;
          const requestedFormat = typeof cmd.format === "string" ? cmd.format : undefined;
          if (requestedFormat === "webp") {
            return errorResponse(cmd.id, "webp screenshots are not supported by this Playwright build");
          }
          const format: "png" | "jpeg" = requestedFormat === "jpeg" ? "jpeg" : "png";
          const quality = typeof cmd.quality === "number" ? cmd.quality : undefined;

          const pathArg = typeof cmd.path === "string" ? cmd.path : undefined;
          const screenshotDirRaw = (cmd as any).screenshotDir;
          const screenshotDir =
            typeof screenshotDirRaw === "string"
              ? (screenshotDirRaw as string)
              : path.join(getSocketDir(), "tmp", "screenshots");

          let savePath = pathArg;
          if (!savePath) {
            const ext = format === "jpeg" ? "jpg" : format;
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const random = Math.random().toString(36).slice(2, 8);
            savePath = path.join(screenshotDir, `screenshot-${timestamp}-${random}.${ext}`);
          }

          await fsPromises.mkdir(path.dirname(savePath), { recursive: true });

          const options: Parameters<typeof page.screenshot>[0] = {
            path: savePath,
            type: format,
            ...(format === "jpeg" && quality !== undefined ? { quality } : {}),
            ...(selector ? {} : { fullPage })
          };

          if (selector) {
            await this.browser.getLocator(selector).screenshot(options);
          } else {
            await page.screenshot(options);
          }

          return successResponse(cmd.id, { path: savePath });
        }
        default:
          return errorResponse(cmd.id, `Not yet implemented: ${cmd.action}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return errorResponse(cmd.id, message);
    }
  }
}

function envIsTruthy(name: string): boolean {
  const raw = process.env[name];
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

function getLaunchConfigFromEnv(): LaunchConfig {
  const headed = envIsTruthy("CAMOUFOX_BROWSER_HEADED") || envIsTruthy("AGENT_BROWSER_HEADED");
  const debug = envIsTruthy("CAMOUFOX_BROWSER_DEBUG") || envIsTruthy("AGENT_BROWSER_DEBUG");

  const argsEnv = process.env.CAMOUFOX_BROWSER_ARGS || process.env.AGENT_BROWSER_ARGS;
  const args =
    argsEnv && argsEnv.trim().length > 0
      ? argsEnv
          .split(/[,\n]/)
          .map((a) => a.trim())
          .filter(Boolean)
      : undefined;

  const proxyServer = process.env.CAMOUFOX_BROWSER_PROXY || process.env.AGENT_BROWSER_PROXY;
  const proxyBypass =
    process.env.CAMOUFOX_BROWSER_PROXY_BYPASS || process.env.AGENT_BROWSER_PROXY_BYPASS;
  const proxy = proxyServer
    ? {
        server: proxyServer,
        ...(proxyBypass ? { bypass: proxyBypass } : {})
      }
    : undefined;

  const ignoreHTTPSErrors =
    envIsTruthy("CAMOUFOX_BROWSER_IGNORE_HTTPS_ERRORS") ||
    envIsTruthy("AGENT_BROWSER_IGNORE_HTTPS_ERRORS");

  const config: LaunchConfig = {
    headless: !headed,
    executablePath:
      process.env.CAMOUFOX_BROWSER_EXECUTABLE_PATH || process.env.AGENT_BROWSER_EXECUTABLE_PATH,
    profile: process.env.CAMOUFOX_BROWSER_PROFILE || process.env.AGENT_BROWSER_PROFILE,
    storageState: process.env.CAMOUFOX_BROWSER_STATE || process.env.AGENT_BROWSER_STATE,
    args,
    userAgent: process.env.CAMOUFOX_BROWSER_USER_AGENT || process.env.AGENT_BROWSER_USER_AGENT,
    proxy,
    ignoreHTTPSErrors
  };

  if (debug) {
    process.stderr.write(`[camoufox-browser] launch config: ${JSON.stringify(config)}\n`);
  }

  return config;
}

function coerceLaunchConfig(cmd: Command): LaunchConfig | null {
  const anyCmd = cmd as Record<string, unknown>;
  const headless = typeof anyCmd.headless === "boolean" ? (anyCmd.headless as boolean) : undefined;
  if (headless === undefined) return null;

  const proxy = (() => {
    const p = anyCmd.proxy;
    if (!p || typeof p !== "object") return undefined;
    const server = typeof (p as any).server === "string" ? (p as any).server : undefined;
    if (!server) return undefined;
    const bypass = typeof (p as any).bypass === "string" ? (p as any).bypass : undefined;
    const username = typeof (p as any).username === "string" ? (p as any).username : undefined;
    const password = typeof (p as any).password === "string" ? (p as any).password : undefined;
    return { server, ...(bypass ? { bypass } : {}), ...(username ? { username } : {}), ...(password ? { password } : {}) };
  })();

  const args = Array.isArray(anyCmd.args) && anyCmd.args.every((a) => typeof a === "string") ? (anyCmd.args as string[]) : undefined;

  return {
    headless,
    executablePath: typeof anyCmd.executablePath === "string" ? (anyCmd.executablePath as string) : undefined,
    profile: typeof anyCmd.profile === "string" ? (anyCmd.profile as string) : undefined,
    storageState: typeof anyCmd.storageState === "string" ? (anyCmd.storageState as string) : undefined,
    proxy,
    args,
    userAgent: typeof anyCmd.userAgent === "string" ? (anyCmd.userAgent as string) : undefined,
    headers: typeof anyCmd.headers === "object" && anyCmd.headers !== null ? (anyCmd.headers as Record<string, string>) : undefined,
    ignoreHTTPSErrors: typeof anyCmd.ignoreHTTPSErrors === "boolean" ? (anyCmd.ignoreHTTPSErrors as boolean) : undefined
  };
}
