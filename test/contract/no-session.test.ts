/**
 * No-session path — contract tests
 *
 * Consumer: Neovim user (Pi is not running)
 * Provider: socket.lua (graceful degradation)
 *
 * Contract: when no Pi session exists, the plugin degrades gracefully.
 * find() returns nil, list() returns an empty table, and send() delivers
 * a human-readable error to the callback rather than throwing.
 *
 * Neovim starts with a fresh XDG_RUNTIME_DIR so no real Pi sessions
 * can accidentally satisfy find().
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { poll } from "../helpers/poll.ts";

let nvim:           NvimHarness;
let emptyRuntimeDir: string;

beforeEach(async () => {
  // Fresh runtime dir — no sockets exist
  emptyRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pivi-no-session-"));

  nvim = await startNvim({
    cwd: process.cwd(),
    env: { XDG_RUNTIME_DIR: emptyRuntimeDir },
  });
});

afterEach(() => {
  nvim.close();
  fs.rmSync(emptyRuntimeDir, { recursive: true, force: true });
});

describe("graceful degradation (no Pi session running)", () => {
  it("find() returns nil", async () => {
    const found = await nvim.lua<string | null>("require('pivi.socket').find()");

    expect(found).toBeNull();
  });

  it("list() returns an empty table", async () => {
    const sessions = await nvim.lua<unknown[]>("require('pivi.socket').list()");

    expect(sessions).toHaveLength(0);
  });

  it("send() delivers a clear 'no session found' error to the callback without throwing", async () => {
    await nvim.client.lua(`
      require('pivi.socket').send(
        { type = 'ping' },
        function(err, resp)
          vim.g.pivi_no_session_err  = err  or 'nil'
          vim.g.pivi_no_session_resp = resp and 'got_resp' or 'nil'
        end
      )
    `);

    // The error is delivered synchronously (find() returns nil immediately),
    // but the callback fires in vim.schedule — give it a moment
    await poll(async () => {
      const val = await nvim.lua<string>("vim.g.pivi_no_session_err");
      return typeof val === "string" && val !== "";
    }, 2000);

    const errVal  = await nvim.lua<string>("vim.g.pivi_no_session_err");
    const respVal = await nvim.lua<string>("vim.g.pivi_no_session_resp");

    expect(errVal).toMatch(/no pivi session found/);
    expect(respVal).toBe("nil");
  });
});
