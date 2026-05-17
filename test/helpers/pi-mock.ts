/**
 * Mock Pi socket server.
 *
 * Simulates the pivi Pi extension (extension.ts) for test purposes:
 * - Opens a Unix socket at $XDG_RUNTIME_DIR/pivi/<pid>-<ts>.sock
 * - Writes a .info metadata file so pivi.socket.find() can discover it
 * - Records every inbound JSON message
 * - Responds to ping and prompt per the pivi protocol
 * - Exposes waitForMessage() for async test assertions
 */

import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export interface PiviMessage {
  type: string;
  message?: string;
  [key: string]: unknown;
}

export interface MockPiServer {
  /** Absolute path to the Unix socket file. */
  socketPath: string;
  /** All messages received so far, in order. */
  messages: PiviMessage[];
  /** Close the server and remove socket + .info files. */
  close(): void;
  /**
   * Resolve when a message of the given type arrives.
   * Rejects if the timeout (default 5 s) elapses first.
   */
  waitForMessage(type: string, timeoutMs?: number): Promise<PiviMessage>;
}

/** Must match PIVI_PROTOCOL_VERSION in extension.ts and M.PROTOCOL_VERSION in socket.lua. */
export const PIVI_PROTOCOL_VERSION = "1";

/** Monotonic counter — makes socket paths unique even within the same millisecond. */
let _seq = 0;

export async function startMockPi(
  cwd: string,
  nvimSocket?: string,
  opts?: { piviVersion?: string; responseDelay?: number },
): Promise<MockPiServer> {
  const piviVersion    = opts?.piviVersion    ?? PIVI_PROTOCOL_VERSION;
  const responseDelay  = opts?.responseDelay  ?? 0;
  const runtimeBase =
    process.env.XDG_RUNTIME_DIR ??
    process.env.TMPDIR ??
    os.tmpdir();
  const socketsDir = path.join(runtimeBase, "pivi");
  fs.mkdirSync(socketsDir, { recursive: true });

  const socketPath = path.join(socketsDir, `mock-${process.pid}-${Date.now()}-${++_seq}.sock`);
  const infoPath   = `${socketPath}.info`;

  const messages: PiviMessage[] = [];
  type Waiter = {
    type: string;
    resolve: (m: PiviMessage) => void;
    reject:  (e: Error)       => void;
  };
  const waiters: Waiter[] = [];

  function dispatch(msg: PiviMessage) {
    messages.push(msg);
    const idx = waiters.findIndex(w => w.type === msg.type);
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      w.resolve(msg);
    }
  }

  const server = net.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString();
      let nl = buf.indexOf("\n");
      while (nl !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) { nl = buf.indexOf("\n"); continue; }

        let msg: PiviMessage;
        try { msg = JSON.parse(line) as PiviMessage; }
        catch { nl = buf.indexOf("\n"); continue; }

        dispatch(msg);

        const reply =
          msg.type === "ping"   ? JSON.stringify({ ok: true, type: "pong", piviVersion }) :
          msg.type === "prompt" ? JSON.stringify({ ok: true }) :
                                  JSON.stringify({ ok: false, error: `unknown type: ${msg.type}` });

        setTimeout(() => conn.write(reply + "\n"), responseDelay);

        nl = buf.indexOf("\n");
      }
    });
    conn.on("error", () => {});
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      fs.writeFileSync(infoPath, JSON.stringify({
        cwd,
        pid:         process.pid,
        startedAt:   new Date().toISOString(),
        nvim:        nvimSocket ?? null,
        piviVersion,
      }));
      resolve();
    });
  });

  return {
    socketPath,
    messages,

    close() {
      server.close();
      try { fs.unlinkSync(socketPath); } catch {}
      try { fs.unlinkSync(infoPath);   } catch {}
      // Reject any outstanding waiters
      for (const w of waiters.splice(0)) {
        w.reject(new Error("MockPiServer closed"));
      }
    },

    waitForMessage(type: string, timeoutMs = 5000): Promise<PiviMessage> {
      // Already received?
      const existing = messages.find(m => m.type === type);
      if (existing) return Promise.resolve(existing);

      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex(w => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for message type "${type}"`));
        }, timeoutMs);

        waiters.push({
          type,
          resolve: (m) => { clearTimeout(timer); resolve(m); },
          reject,
        });
      });
    },
  };
}
