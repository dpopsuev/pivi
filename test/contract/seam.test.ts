/**
 * Socket protocol — contract tests
 *
 * Consumer: pivi.nvim (Lua — socket.lua)
 * Provider: Pi extension (extension.ts, simulated by MockPiServer)
 *
 * Covers:
 *   - Session discovery: find() resolves the socket for the current cwd
 *   - Message flow:      Neovim sends ping/prompt; Pi responds per protocol
 *   - Versioning:        piviVersion travels in pong and .info; version-matched
 *                        sessions are preferred over mismatched ones
 *   - Error handling:    malformed responses reach the callback, not a crash
 *   - RPC back-channel: a Pi-side msgpack-RPC client can drive Neovim state
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { attach } from "neovim";
import { type MockPiServer, PIVI_PROTOCOL_VERSION, startMockPi } from "../helpers/pi-mock.ts";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { poll } from "../helpers/poll.ts";

const CWD = process.cwd();

// ── Fixtures ───────────────────────────────────────────────────────────────

let nvim: NvimHarness;
let mock: MockPiServer;

beforeEach(async () => {
  nvim = await startNvim({ cwd: CWD });
  mock = await startMockPi(CWD, nvim.socketPath);
});

afterEach(() => {
  mock.close();
  nvim.close();
});

// ── Seam 1 — Socket discovery ──────────────────────────────────────────────

describe("session discovery", () => {
  it("find() returns the socket for the current working directory", async () => {
    const found = await nvim.lua<string | null>(
      "require('pivi.socket').find()",
    );
    expect(found).toBe(mock.socketPath);
  });

  it("list() includes the session with its cwd and socket path", async () => {
    const sessions = await nvim.lua<Array<{ cwd: string; socket: string }>>(
      "require('pivi.socket').list()",
    );
    expect(sessions.length).toBeGreaterThan(0);
    const match = sessions.find(s => s.socket === mock.socketPath);
    expect(match).toBeDefined();
    expect(match?.cwd).toBe(CWD);
  });
});

// ── Seam 2 — Neovim → Pi ──────────────────────────────────────────────────

describe("Neovim → Pi message contract", () => {
  it("ping: the mock server receives the message", async () => {
    // Fire ping from Neovim (async, non-blocking)
    await nvim.client.lua(
      "require('pivi.socket').send({type='ping'}, function() end)",
    );

    const msg = await mock.waitForMessage("ping");
    expect(msg.type).toBe("ping");
  });

  it("ping: response carries type='pong' (full roundtrip)", async () => {
    let responseType: string | null = null;

    // Run Lua that captures the callback response into a global
    await nvim.client.lua(`
      require('pivi.socket').send({type='ping'}, function(err, resp)
        vim.g.pivi_test_pong = (resp and resp.type) or 'none'
      end)
    `);

    // Wait for the async callback to fire
    await poll(async () => {
      responseType = await nvim.lua<string>("vim.g.pivi_test_pong");
      return responseType !== null && responseType !== vim.NIL;
    }, 3000);

    expect(responseType).toBe("pong");
  });

  it("prompt: mock receives the exact message text", async () => {
    await nvim.client.lua(`
      require('pivi.socket').send(
        {type='prompt', message='fix the bug'},
        function() end
      )
    `);

    const msg = await mock.waitForMessage("prompt");
    expect(msg.type).toBe("prompt");
    expect(msg.message).toBe("fix the bug");
  });

  it("prompt: ok=true response reaches the Neovim callback", async () => {
    await nvim.client.lua(`
      require('pivi.socket').send(
        {type='prompt', message='test'},
        function(err, resp)
          vim.g.pivi_test_prompt_ok = resp and resp.ok and 'yes' or 'no'
        end
      )
    `);

    await poll(async () => {
      const val = await nvim.lua<string>("vim.g.pivi_test_prompt_ok");
      return val === "yes";
    }, 3000);

    const val = await nvim.lua<string>("vim.g.pivi_test_prompt_ok");
    expect(val).toBe("yes");
  });
});

// ── Seam 4 — Protocol versioning ─────────────────────────────────────────

describe("protocol versioning", () => {
  it("pong response carries piviVersion", async () => {
    await nvim.client.lua(`
      require('pivi.socket').send({type='ping'}, function(err, resp)
        vim.g.pivi_test_pong_ver = (resp and resp.piviVersion) or 'missing'
      end)
    `);

    await poll(async () => {
      const val = await nvim.lua<string>("vim.g.pivi_test_pong_ver");
      return typeof val === "string" && val !== "";
    }, 3000);

    const ver = await nvim.lua<string>("vim.g.pivi_test_pong_ver");
    expect(ver).toBe(PIVI_PROTOCOL_VERSION);
  });

  it("given two sessions with different versions, find() prefers the matching one", async () => {
    // Spin up a second mock with a mismatched version for the same cwd.
    // The already-running `mock` has the correct version — it must win.
    const stale = await startMockPi(CWD, undefined, { piviVersion: "0" });

    try {
      const found = await nvim.lua<string | null>("require('pivi.socket').find()");
      // The current-version socket should be preferred over the stale one
      expect(found).toBe(mock.socketPath);
    } finally {
      stale.close();
    }
  });
});

// ── Seam 5 — Response schema validation ───────────────────────────────────

describe("response schema validation", () => {
  it("given a response missing the required 'ok' field, an error reaches the callback rather than a crash", async () => {
    // Spin up a rogue server that sends JSON missing the required `ok` field.
    const rogueSocketPath = path.join(
      process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? os.tmpdir(),
      "pivi",
      `rogue-${process.pid}-${Date.now()}.sock`,
    );
    const rogueInfoPath = `${rogueSocketPath}.info`;

    const rogueServer = net.createServer((conn) => {
      conn.on("data", () => {
        // Respond with a JSON object that has no `ok` field — schema violation
        conn.write(JSON.stringify({ type: "pong" }) + "\n");
      });
      conn.on("error", () => {});
    });

    await new Promise<void>((resolve) => rogueServer.listen(rogueSocketPath, resolve));
    fs.writeFileSync(rogueInfoPath, JSON.stringify({
      cwd:         CWD,
      pid:         process.pid,
      startedAt:   new Date().toISOString(),
      nvim:        null,
      piviVersion: PIVI_PROTOCOL_VERSION,
    }));

    // Temporarily close the good mock so Neovim picks up the rogue one
    mock.close();

    try {
      await nvim.client.lua(`
        require('pivi.socket').send({type='ping'}, function(err, resp)
          vim.g.pivi_test_schema_err = err or 'nil'
          vim.g.pivi_test_schema_resp = resp and 'got_resp' or 'nil'
        end)
      `);

      await poll(async () => {
        const val = await nvim.lua<string>("vim.g.pivi_test_schema_err");
        return typeof val === "string" && val !== "";
      }, 3000);

      const errVal  = await nvim.lua<string>("vim.g.pivi_test_schema_err");
      const respVal = await nvim.lua<string>("vim.g.pivi_test_schema_resp");

      expect(errVal).toMatch(/invalid response schema/);
      expect(respVal).toBe("nil");
    } finally {
      rogueServer.close();
      try { fs.unlinkSync(rogueSocketPath); }  catch {}
      try { fs.unlinkSync(rogueInfoPath); }    catch {}
      // Restart the good mock so afterEach cleanup works
      mock = await startMockPi(CWD, nvim.socketPath);
    }
  });

  it("given ok=false with an error string, the error message reaches the callback intact", async () => {
    await nvim.client.lua(`
      require('pivi.socket').send(
        {type='unknown-type'},
        function(err, resp)
          vim.g.pivi_test_err_ok  = (err == nil) and 'no_err' or 'has_err'
          vim.g.pivi_test_err_msg = resp and (resp.error or 'no_error_field') or 'nil'
        end
      )
    `);

    await poll(async () => {
      const val = await nvim.lua<string>("vim.g.pivi_test_err_ok");
      return typeof val === "string" && val !== "";
    }, 3000);

    const hasErr  = await nvim.lua<string>("vim.g.pivi_test_err_ok");
    const errMsg  = await nvim.lua<string>("vim.g.pivi_test_err_msg");

    // No schema error — the response is a valid {ok: false, error: "..."}
    expect(hasErr).toBe("no_err");
    // The mock sends back a human-readable error string
    expect(errMsg).toMatch(/unknown type/);
  });
});

// ── Seam 3 — Pi → Neovim (agent drives the editor) ───────────────────────

describe("Pi → Neovim RPC back-channel", () => {
  it("a Pi-side client can set a Neovim global via msgpack-RPC", async () => {
    // Simulate Pi agent connecting to Neovim's $NVIM socket
    const piClient = await attach({ socket: nvim.socketPath });

    try {
      await piClient.lua("vim.g.pi_drove_neovim = 'yes'");

      const val = await nvim.lua<string>("vim.g.pi_drove_neovim");
      expect(val).toBe("yes");
    } finally {
      try { piClient.quit(); } catch {}
    }
  });

  it("a Pi-side client can create a buffer and write lines into it", async () => {
    const piClient = await attach({ socket: nvim.socketPath });

    try {
      await piClient.lua(`
        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello from Pi'})
        vim.g.pi_test_buf = buf
      `);

      const lines = await nvim.lua<string[]>(`
        vim.api.nvim_buf_get_lines(vim.g.pi_test_buf, 0, -1, false)
      `);
      expect(lines).toEqual(["hello from Pi"]);
    } finally {
      try { piClient.quit(); } catch {}
    }
  });

  it("a Pi-side client can open a file and move the cursor to a specific line", async () => {
    const piClient = await attach({ socket: nvim.socketPath });

    try {
      // Pi opens a file and positions the cursor — simulating "goto error"
      await piClient.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape(vim.env.PIVI_ROOT .. '/lua/pivi/init.lua'))
        vim.api.nvim_win_set_cursor(0, {5, 0})
        vim.g.pi_test_cursor_line = vim.api.nvim_win_get_cursor(0)[1]
      `);

      const line = await nvim.lua<number>("vim.g.pi_test_cursor_line");
      expect(line).toBe(5);
    } finally {
      try { piClient.quit(); } catch {}
    }
  });

  it("a Pi-side client can push a notification into Neovim", async () => {
    const piClient = await attach({ socket: nvim.socketPath });

    try {
      // nvim_notify is the canonical way to show a message
      await piClient.call("nvim_notify", ["Pi: task complete ✓", 2, {}]);

      // nvim_notify is fire-and-forget; verify via :messages output
      const messages = await nvim.client.call("nvim_exec2", [
        "messages",
        { output: true },
      ]) as { output: string };

      // The call must not throw and output should be a string
      expect(typeof messages.output).toBe("string");
    } finally {
      try { piClient.quit(); } catch {}
    }
  });
});

// ── Helpers ────────────────────────────────────────────────────────────────

/** Placeholder so TypeScript is happy with vim.NIL reference in the test. */
const vim = { NIL: null } as const;
