#!/usr/bin/env node
/**
 * Daemon entrypoint (spawned by CLI).
 *
 * Listens on a per-session IPC endpoint (Unix socket or Windows localhost TCP).
 * The CLI communicates via JSON-line protocol.
 */

import { DaemonServer } from "./server.js";

async function main(): Promise<void> {
  const server = new DaemonServer();
  await server.start();
}

main().catch((err) => {
  process.stderr.write(`[camoufox-browser] Fatal: ${err?.message ?? String(err)}\n`);
  process.exit(1);
});
