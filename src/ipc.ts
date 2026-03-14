import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

export const isWindows = process.platform === "win32";

export function isValidSessionName(name: string): boolean {
  if (!name) return false;
  if (name.length > 64) return false;
  if (name.includes("..")) return false;
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

/**
 * Get the base directory for socket/pid files.
 * Priority: CAMOUFOX_BROWSER_SOCKET_DIR > AGENT_BROWSER_SOCKET_DIR > XDG_RUNTIME_DIR > ~/.camoufox-browser > tmpdir
 */
export function getSocketDir(): string {
  const explicit = process.env.CAMOUFOX_BROWSER_SOCKET_DIR || process.env.AGENT_BROWSER_SOCKET_DIR;
  if (explicit && explicit.length > 0) return explicit;

  if (process.env.XDG_RUNTIME_DIR && process.env.XDG_RUNTIME_DIR.length > 0) {
    return path.join(process.env.XDG_RUNTIME_DIR, "camoufox-browser");
  }

  const home = os.homedir();
  if (home) return path.join(home, ".camoufox-browser");

  return path.join(os.tmpdir(), "camoufox-browser");
}

export function ensureSocketDir(): void {
  const dir = getSocketDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
}

export function getPidFile(session: string): string {
  return path.join(getSocketDir(), `${session}.pid`);
}

export function getUnixSocketPath(session: string): string {
  return path.join(getSocketDir(), `${session}.sock`);
}

export function getPortFile(session: string): string {
  return path.join(getSocketDir(), `${session}.port`);
}

export function cleanupIpcFiles(session: string): void {
  const pidFile = getPidFile(session);
  const portFile = getPortFile(session);
  const sockPath = getUnixSocketPath(session);

  try {
    if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
  } catch {}
  try {
    if (fs.existsSync(portFile)) fs.unlinkSync(portFile);
  } catch {}
  try {
    if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath);
  } catch {}
}

/**
 * Get port number for TCP mode (Windows).
 * Uses a hash of the session name to get a consistent port.
 */
export function getPortForSession(session: string): number {
  let hash = 0;
  for (let i = 0; i < session.length; i++) {
    hash = (hash << 5) - hash + session.charCodeAt(i);
    hash |= 0;
  }
  return 49152 + (Math.abs(hash) % 16383);
}

