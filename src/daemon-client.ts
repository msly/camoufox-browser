import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  cleanupIpcFiles,
  ensureSocketDir,
  getPortForSession,
  getUnixSocketPath,
  isWindows
} from "./ipc.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function daemonReady(session: string): Promise<boolean> {
  if (isWindows) {
    const port = getPortForSession(session);
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
        socket.destroy();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
      socket.setTimeout(200, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  const sockPath = getUnixSocketPath(session);
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection(sockPath, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(200, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function getProjectRoot(): string {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return path.join(__dirname, "..");
}

function getDaemonEntrypoint(): { cmd: string; args: string[]; cwd: string } {
  const root = getProjectRoot();
  const distDaemon = path.join(root, "dist", "daemon.js");
  if (fs.existsSync(distDaemon)) {
    return { cmd: "node", args: [distDaemon], cwd: root };
  }
  const srcDaemon = path.join(root, "src", "daemon.ts");
  return { cmd: "node", args: ["--import", "tsx", srcDaemon], cwd: root };
}

export async function ensureDaemonRunning(session: string): Promise<{ alreadyRunning: boolean }> {
  ensureSocketDir();

  if (await daemonReady(session)) {
    return { alreadyRunning: true };
  }

  cleanupIpcFiles(session);

  const { cmd, args, cwd } = getDaemonEntrypoint();
  spawn(cmd, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      CAMOUFOX_BROWSER_SESSION: session
    }
  }).unref();

  for (let attempt = 0; attempt < 50; attempt++) {
    if (await daemonReady(session)) {
      return { alreadyRunning: false };
    }
    await sleep(100);
  }

  throw new Error("Daemon did not start within 5 seconds");
}

