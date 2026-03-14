import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import { ensureDaemonRunning } from "./daemon-client.js";
import { getUnixSocketPath } from "./ipc.js";

function randomSessionName(): string {
  return `test_${process.pid}_${Math.random().toString(16).slice(2)}`;
}

async function sendCommand(sockPath: string, command: Record<string, unknown>): Promise<any> {
  return await new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath, () => {
      socket.write(JSON.stringify(command) + "\n");
    });

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const idx = buffer.indexOf("\n");
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      socket.destroy();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`Invalid response: ${line}`));
      }
    });
    socket.on("error", reject);
  });
}

async function waitForSocketGone(sockPath: string, timeoutMs: number = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!fs.existsSync(sockPath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Socket did not disappear: ${sockPath}`);
}

describe("ensureDaemonRunning()", () => {
  let tempDir = "";
  let session = "";

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "camoufox-browser-test-"));
    session = randomSessionName();
    process.env.CAMOUFOX_BROWSER_SOCKET_DIR = tempDir;
    process.env.CAMOUFOX_BROWSER_IDLE_TIMEOUT_MS = "0";
  });

  afterEach(() => {
    delete process.env.CAMOUFOX_BROWSER_SOCKET_DIR;
    delete process.env.CAMOUFOX_BROWSER_IDLE_TIMEOUT_MS;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("spawns the daemon on demand and responds", async () => {
    const result = await ensureDaemonRunning(session);
    expect(result.alreadyRunning).toBe(false);

    const sockPath = getUnixSocketPath(session);
    expect(fs.existsSync(sockPath)).toBe(true);

    const resp1 = await sendCommand(sockPath, { id: "r1", action: "nope" });
    expect(resp1).toMatchObject({ id: "r1", success: false });

    const resp2 = await sendCommand(sockPath, { id: "r2", action: "close" });
    expect(resp2).toMatchObject({ id: "r2", success: true, data: { closed: true } });

    await waitForSocketGone(sockPath);
  });
});
