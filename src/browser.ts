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
  private pages: Page[] = [];
  private activePageIndex = 0;
  private isPersistentContext = false;
  private launchConfig: LaunchConfig | null = null;

  private refMap: RefMap = {};
  private lastSnapshot = "";

  isLaunched(): boolean {
    return this.browser !== null || this.isPersistentContext;
  }

  hasPages(): boolean {
    return this.pages.length > 0;
  }

  async ensurePage(): Promise<void> {
    if (!this.context) throw new Error("Browser not launched. Call open first.");
    if (this.pages.length > 0) return;

    const page = this.context.pages()[0] || (await this.context.newPage());
    this.trackPage(page);
    this.activePageIndex = this.pages.indexOf(page);
    if (this.activePageIndex < 0) this.activePageIndex = 0;
    await page.bringToFront().catch(() => {});
  }

  getPage(): Page {
    const page = this.pages[this.activePageIndex] || this.pages[0];
    if (!page) {
      throw new Error("Browser not launched. Call open first.");
    }
    return page;
  }

  getContext(): BrowserContext {
    if (!this.context) {
      throw new Error("Browser not launched. Call open first.");
    }
    return this.context;
  }

  getActiveIndex(): number {
    return this.activePageIndex;
  }

  getLastSnapshot(): string {
    return this.lastSnapshot;
  }

  getRefMap(): RefMap {
    return this.refMap;
  }

  getLaunchConfig(): LaunchConfig | null {
    return this.launchConfig;
  }

  private trackPage(page: Page): void {
    if (this.pages.includes(page)) return;
    this.pages.push(page);

    page.on("close", () => {
      const idx = this.pages.indexOf(page);
      if (idx < 0) return;
      this.pages.splice(idx, 1);
      if (this.pages.length === 0) {
        this.activePageIndex = 0;
        return;
      }
      if (this.activePageIndex >= this.pages.length) {
        this.activePageIndex = this.pages.length - 1;
      } else if (this.activePageIndex > idx) {
        this.activePageIndex--;
      }
    });
  }

  private setupContextTracking(context: BrowserContext): void {
    context.on("page", (page) => {
      this.trackPage(page);
      const idx = this.pages.indexOf(page);
      if (idx >= 0 && idx !== this.activePageIndex) {
        this.activePageIndex = idx;
      }
    });
  }

  async launch(config: LaunchConfig): Promise<void> {
    if (this.isLaunched()) return;
    this.launchConfig = config;

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
      this.setupContextTracking(ctx);
      const initial = ctx.pages();
      if (initial.length > 0) {
        for (const p of initial) this.trackPage(p);
        this.activePageIndex = 0;
      } else {
        const p = await ctx.newPage();
        this.trackPage(p);
        this.activePageIndex = this.pages.indexOf(p);
      }
      await this.getPage().bringToFront().catch(() => {});
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
    this.setupContextTracking(this.context);
    const initial = this.context.pages();
    if (initial.length > 0) {
      for (const p of initial) this.trackPage(p);
      this.activePageIndex = 0;
    } else {
      const p = await this.context.newPage();
      this.trackPage(p);
      this.activePageIndex = this.pages.indexOf(p);
    }
    await this.getPage().bringToFront().catch(() => {});
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
    this.trackPage(page);
    this.activePageIndex = this.pages.indexOf(page);
    if (this.activePageIndex < 0) this.activePageIndex = Math.max(0, this.pages.length - 1);
    await page.bringToFront().catch(() => {});
    return page;
  }

  async newTabManaged(): Promise<{ index: number; total: number }> {
    await this.newTab();
    return { index: this.activePageIndex, total: this.pages.length };
  }

  async switchTo(index: number): Promise<{ index: number; url: string; title: string }> {
    if (index < 0 || index >= this.pages.length) {
      throw new Error(`Invalid tab index: ${index}. Available: 0-${Math.max(0, this.pages.length - 1)}`);
    }
    this.activePageIndex = index;
    const page = this.getPage();
    await page.bringToFront().catch(() => {});
    return { index: this.activePageIndex, url: page.url(), title: "" };
  }

  async closeTab(index?: number): Promise<{ closed: number; remaining: number }> {
    const targetIndex = index ?? this.activePageIndex;
    if (targetIndex < 0 || targetIndex >= this.pages.length) {
      throw new Error(`Invalid tab index: ${targetIndex}`);
    }
    if (this.pages.length === 1) {
      throw new Error('Cannot close the last tab. Use "close" to close the browser.');
    }

    const page = this.pages[targetIndex];
    await page.close();
    const idx = this.pages.indexOf(page);
    if (idx >= 0) {
      this.pages.splice(idx, 1);
    }

    if (this.activePageIndex >= this.pages.length) {
      this.activePageIndex = this.pages.length - 1;
    } else if (this.activePageIndex > targetIndex) {
      this.activePageIndex--;
    }

    await this.getPage().bringToFront().catch(() => {});

    return { closed: targetIndex, remaining: this.pages.length };
  }

  async listTabs(): Promise<Array<{ index: number; url: string; title: string; active: boolean }>> {
    return await Promise.all(
      this.pages.map(async (page, index) => ({
        index,
        url: page.url(),
        title: await page.title().catch(() => ""),
        active: index === this.activePageIndex
      }))
    );
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
    this.pages = [];
    this.activePageIndex = 0;
    this.isPersistentContext = false;
    this.launchConfig = null;
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
