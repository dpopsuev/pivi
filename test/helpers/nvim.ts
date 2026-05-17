/**
 * Headless Neovim harness.
 *
 * Spawns `nvim --headless --listen <socket>` with a minimal test init.lua
 * that loads the pivi plugin. Connects via the official @neovim/api
 * msgpack-RPC client so tests can call any Neovim API or run Lua.
 *
 * Also exposes the Neovim socket path so mock Pi servers can connect
 * back to simulate Pi inside Neovim.
 */

import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { attach, type NeovimClient } from "neovim";

const PIVI_ROOT    = path.resolve(__dirname, "../..");
const FIXTURE_INIT = path.resolve(__dirname, "../fixtures/init.lua");

export interface NvimHarness {
  /** The live @neovim/api RPC client. */
  client: NeovimClient;
  /** Path to Neovim's listening socket — pass to MockPiServer as nvimSocket. */
  socketPath: string;
  /**
   * Execute a Lua chunk in the running Neovim and return its result.
   * Uses `return` implicitly — do NOT add `return` yourself.
   *
   * @example
   * const found = await h.lua<string | null>("require('pivi.socket').find()");
   */
  lua<T = unknown>(chunk: string): Promise<T>;
  /** Shut down Neovim and clean up. */
  close(): void;
}

export async function startNvim(opts?: { cwd?: string; env?: Record<string, string> }): Promise<NvimHarness> {
  const socketPath = path.join(
    os.tmpdir(),
    `pivi-test-nvim-${process.pid}-${Date.now()}.sock`,
  );

  const proc: ChildProcess = spawn(
    "nvim",
    [
      "--headless",
      "--listen", socketPath,
      "-u", FIXTURE_INIT,
    ],
    {
      cwd: opts?.cwd ?? process.cwd(),
      env: {
        ...process.env,
        PIVI_ROOT,
        NVIM_LOG_FILE: "/dev/null",
        ...opts?.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  proc.on("error", (err) => {
    throw new Error(`Failed to spawn nvim: ${err.message}`);
  });

  // Wait for socket to appear (Neovim opens it after startup)
  await waitForFile(socketPath, 8000);

  const client = await attach({ socket: socketPath });

  return {
    client,
    socketPath,

    async lua<T = unknown>(chunk: string): Promise<T> {
      return client.lua(`return ${chunk}`) as Promise<T>;
    },

    close() {
      try { client.quit(); }  catch {}
      try { proc.kill(); }    catch {}
      try { fs.unlinkSync(socketPath); } catch {}
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    function poll() {
      if (fs.existsSync(filePath)) { resolve(); return; }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${filePath}`));
        return;
      }
      setTimeout(poll, 50);
    }
    poll();
  });
}
