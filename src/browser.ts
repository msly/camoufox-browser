import * as os from "node:os";
import type { Browser, BrowserContext, Locator, Page } from "playwright-core";
import { getEnhancedSnapshot, parseRef, type EnhancedSnapshot, type RefMap, type SnapshotOptions } from "./snapshot.js";

export type LaunchConfig = {
  headless: boolean;
  executablePath?: string;
  profile?: string;
  storageState?: string;
  proxy?: { server: string; bypass?: string; username?: string; password?: string };
  args?: string[];
  userAgent?: string;
  headers?: Record<string, string>;
  ignoreHTTPSErrors?: boolean;
};

function expandTilde(p: string): string {
  if (!p.startsWith("~/")) return p;
  return `${os.homedir()}/${p.slice(2)}`;
}

export class BrowserManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private isPersistentContext = false;

  private refMap: RefMap = {};
  private lastSnapshot = "";

  isLaunched(): boolean {
    return this.browser !== null || this.isPersistentContext;
  }

  hasPages(): boolean {
    return this.page !== null;
  }

  async ensurePage(): Promise<void> {
    if (this.page) return;
    if (!this.context) throw new Error("Browser not launched. Call open first.");
    this.page = this.context.pages()[0] || (await this.context.newPage());
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser not launched. Call open first.");
    }
    return this.page;
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Browser not launched. Call open first.");
    }
    return this.context;
  }

  getLastSnapshot(): string {
    return this.lastSnapshot;
  }

  getRefMap(): RefMap {
    return this.refMap;
  }

  async launch(config: LaunchConfig): Promise<void> {
    if (this.isLaunched()) return;

    let Camoufox: typeof import("camoufox-js")["Camoufox"];
    try {
      ({ Camoufox } = await import("camoufox-js"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("better-sqlite3") && message.includes("Could not locate the bindings file")) {
        throw new Error(
          [
            "better-sqlite3 native bindings are missing (required by camoufox-js).",
            "If you installed dependencies with pnpm, allow build scripts and rebuild:",
            "  pnpm -C camoufox-browser install",
            "  pnpm -C camoufox-browser rebuild better-sqlite3",
            "If you're using npm, reinstall should run the build scripts automatically."
          ].join("\n")
        );
      }
      throw err;
    }

    const headless = config.headless;
    const executable_path = config.executablePath;
    const args = config.args;
    const proxy = config.proxy;

    if (config.profile) {
      const user_data_dir = expandTilde(config.profile);
      const ctx = (await Camoufox({
        headless,
        user_data_dir,
        ...(executable_path ? { executable_path } : {}),
        ...(args ? { args } : {}),
        ...(proxy ? { proxy } : {}),
        ...(config.userAgent ? { userAgent: config.userAgent } : {}),
        ...(config.headers ? { extraHTTPHeaders: config.headers } : {}),
        ...(config.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {})
      })) as unknown as BrowserContext;

      this.context = ctx;
      this.isPersistentContext = true;
      this.page = ctx.pages()[0] || (await ctx.newPage());
      return;
    }

    const b = (await Camoufox({
      headless,
      ...(executable_path ? { executable_path } : {}),
      ...(args ? { args } : {}),
      ...(proxy ? { proxy } : {})
    })) as unknown as Browser;

    this.browser = b;
    this.context = await b.newContext({
      ...(config.userAgent ? { userAgent: config.userAgent } : {}),
      ...(config.headers ? { extraHTTPHeaders: config.headers } : {}),
      ...(config.storageState ? { storageState: config.storageState } : {}),
      ...(config.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {})
    });
    this.page = this.context.pages()[0] || (await this.context.newPage());
  }

  async navigate(
    url: string,
    options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle"; headers?: Record<string, string> }
  ): Promise<{ url: string; title: string }> {
    await this.ensurePage();
    const page = this.getPage();
    if (options?.headers && Object.keys(options.headers).length > 0) {
      await page.setExtraHTTPHeaders(options.headers);
    }
    await page.goto(url, { waitUntil: options?.waitUntil ?? "load" });
    return { url: page.url(), title: await page.title() };
  }

  async newTab(): Promise<Page> {
    const ctx = this.getContext();
    const page = await ctx.newPage();
    this.page = page;
    await page.bringToFront().catch(() => {});
    return page;
  }

  async getSnapshot(options?: SnapshotOptions): Promise<EnhancedSnapshot> {
    const page = this.getPage();
    const snapshot = await getEnhancedSnapshot(page, options);
    this.refMap = snapshot.refs;
    this.lastSnapshot = snapshot.tree;
    return snapshot;
  }

  getLocatorFromRef(refArg: string): Locator | null {
    const ref = parseRef(refArg);
    if (!ref) return null;

    const refData = this.refMap[ref];
    if (!refData) return null;

    const page = this.getPage();

    if (refData.role === "clickable" || refData.role === "focusable") {
      return page.locator(refData.selector);
    }

    let locator: Locator = page.getByRole(refData.role as any, {
      name: refData.name,
      exact: true
    });

    if (refData.nth !== undefined) {
      locator = locator.nth(refData.nth);
    }

    return locator;
  }

  getLocator(selectorOrRef: string): Locator {
    const refLocator = this.getLocatorFromRef(selectorOrRef);
    if (refLocator) return refLocator;
    return this.getPage().locator(selectorOrRef);
  }

  async close(): Promise<void> {
    const browser = this.browser;
    const context = this.context;

    this.browser = null;
    this.context = null;
    this.page = null;
    this.isPersistentContext = false;
    this.refMap = {};
    this.lastSnapshot = "";

    if (browser) {
      try {
        await browser.close();
      } catch {}
      return;
    }

    if (context) {
      try {
        await context.close();
      } catch {}
    }
  }
}
