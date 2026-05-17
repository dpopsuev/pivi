/**
 * nvim_lua — contract tests
 *
 * Consumer: Pi LLM agent (calls nvim_lua to access the full Neovim API)
 * Provider: extension.ts nvim_lua tool (delegates to nvimClient.lua())
 *
 * Contract: execute arbitrary Lua in Neovim, return result as string.
 * Errors are surfaced as messages, not crashes. Null client is handled.
 * Tool ablation: when Pi is inside Neovim, pi.getActiveTools() contains
 * nvim_lua and does NOT contain Pi's built-in bash, edit, read, etc.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";

const CWD = process.cwd();

let nvim:     NvimHarness;
let piClient: NeovimClient;

beforeEach(async () => {
  nvim     = await startNvim({ cwd: CWD });
  piClient = await attach({ socket: nvim.socketPath });
});

afterEach(() => {
  try { piClient.quit(); } catch {}
  nvim.close();
});

// ── The nvimLua() helper logic — tested via direct piClient calls ──────────
// These tests validate the operations that nvim_lua's execute() performs,
// which is what the tool would do via the existing nvimLua() helper.

describe("nvim_lua — general Lua execution", () => {
  it("given valid Lua returning a scalar: value is returned as a string", async () => {
    const result = await piClient.lua("return 1 + 1");
    expect(String(result)).toBe("2");
  });

  it("given a multi-step IIFE pipeline: final value is returned", async () => {
    const result = await piClient.lua(`
      return (function()
        local t = {}
        for i = 1, 3 do table.insert(t, i * 2) end
        return table.concat(t, ',')
      end)()
    `);
    expect(String(result)).toBe("2,4,6");
  });

  it("given Lua that raises an error: can be caught without crashing", async () => {
    let caught: string | null = null;
    try {
      await piClient.lua("return error('test error')");
    } catch (e) {
      caught = String(e);
    }
    expect(caught).not.toBeNull();
    expect(caught).toContain("test error");
  });

  it("given package.loaded discovery: returns a non-empty string", async () => {
    const result = (await piClient.lua(
      "return vim.inspect(package.loaded)",
    )) as string;
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(10);
  });

  it("given vim.fn.getcompletion() discovery: returns nvim_buf_ function names", async () => {
    const result = (await piClient.lua(`
      return (function()
        local fns = vim.fn.getcompletion('nvim_buf_', 'function')
        return table.concat(fns, ',')
      end)()
    `)) as string;
    expect(result).toContain("nvim_buf_get_lines");
    expect(result).toContain("nvim_buf_set_lines");
  });

  it("given vim.system() via nvim_lua: executes a shell command and returns output", async () => {
    const result = (await piClient.lua(`
      return (function()
        local obj = vim.system({'echo', 'hello-pivi'}):wait()
        return vim.trim(obj.stdout)
      end)()
    `)) as string;
    expect(result).toBe("hello-pivi");
  });

  it("given nvim_buf_set_text via nvim_lua: surgical edit in open buffer", async () => {
    await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello world'})
      vim.api.nvim_buf_set_text(buf, 0, 6, 0, 11, {'neovim'})
      vim.g.pivi_test_set_text = vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1]
    `);
    const result = await nvim.lua<string>("vim.g.pivi_test_set_text");
    expect(result).toBe("hello neovim");
  });
});
