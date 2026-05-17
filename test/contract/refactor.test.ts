/**
 * Refactor tasks — contract tests (PIV-TSK-27)
 *
 * Proves two mechanisms Pi uses for structural refactoring:
 *
 * 1. nvim_buf_set_text — surgical character-level edits that preserve extmarks.
 *    nvim_buf_set_lines (full-buffer replace) blows extmarks away.
 *    Pi uses set_text via nvim_lua for all in-place edits.
 *
 * 2. Treesitter — AST-aware range detection so Pi can identify exactly
 *    which lines a function spans before extracting or rewriting it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

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

// ── nvim_buf_set_text: surgical edits preserve extmarks ───────────────────────
//
// Extmarks (used by LSP highlights, diagnostics, virtual text) track character
// positions. nvim_buf_set_text replaces a specific character range; extmarks
// outside that range are unaffected. nvim_buf_set_lines replaces whole lines
// and repositions extmarks — column-level marks are lost.

describe("nvim_buf_set_text: surgical edit preserves extmarks", () => {
  it("an extmark before the edited range survives set_text", async () => {
    const count = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello world'})
      local ns = vim.api.nvim_create_namespace('pivi_refactor_test')
      -- Mark at col 0 (before the edit range col 6-11)
      vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {})
      -- Surgical edit: replace "world" (col 6-11) with "neovim"
      vim.api.nvim_buf_set_text(buf, 0, 6, 0, 11, {'neovim'})
      local marks = vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})
      return #marks
    `) as number;

    expect(count).toBe(1); // extmark survived
  });

  it("the edited text is correct after set_text", async () => {
    const result = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello world'})
      vim.api.nvim_buf_set_text(buf, 0, 6, 0, 11, {'neovim'})
      return vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1]
    `) as string;

    expect(result).toBe("hello neovim");
  });

  it("set_text on a multi-line buffer only touches the specified range", async () => {
    const lines = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false,
        {'line one', 'line two', 'line three'})
      -- Edit only line 1 (0-indexed), col 5-8: replace "two" with "2"
      vim.api.nvim_buf_set_text(buf, 1, 5, 1, 8, {'2'})
      return vim.api.nvim_buf_get_lines(buf, 0, -1, false)
    `) as string[];

    expect(lines[0]).toBe("line one");
    expect(lines[1]).toBe("line 2");
    expect(lines[2]).toBe("line three");
  });

  it("set_text can insert without deleting (zero-width replacement)", async () => {
    const result = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'ab'})
      -- Insert 'X' between a and b: replace (0,1)-(0,1) with 'X'
      vim.api.nvim_buf_set_text(buf, 0, 1, 0, 1, {'X'})
      return vim.api.nvim_buf_get_lines(buf, 0, -1, false)[1]
    `) as string;

    expect(result).toBe("aXb");
  });
});

describe("nvim_buf_set_lines vs set_text: extmark behaviour", () => {
  it("set_lines repositions extmarks to start of replaced range", async () => {
    // set_lines is a line-level operation. Extmarks on a replaced line
    // are moved to line 0 col 0 of the replacement — they don't disappear
    // but they lose their original column position.
    // This is why Pi uses set_text for surgical edits.
    const before = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello world'})
      local ns = vim.api.nvim_create_namespace('pivi_setlines_test')
      vim.api.nvim_buf_set_extmark(buf, ns, 0, 6, {})  -- mark at col 6
      -- Full-line replace: destroys column precision
      vim.api.nvim_buf_set_lines(buf, 0, 1, false, {'hello neovim'})
      local marks = vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})
      -- Mark still exists but column is reset to 0 (line-level granularity)
      if #marks > 0 then return marks[1][3] else return -1 end
    `) as number;

    // set_lines keeps the mark but moves it to col 0 — column precision lost
    expect(before).toBe(0);
  });

  it("set_text preserves extmark column position exactly", async () => {
    const col = await piClient.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_buf_set_lines(buf, 0, -1, false, {'hello world'})
      local ns = vim.api.nvim_create_namespace('pivi_settext_test')
      vim.api.nvim_buf_set_extmark(buf, ns, 0, 0, {})  -- mark at col 0
      -- Surgical: only change col 6-11
      vim.api.nvim_buf_set_text(buf, 0, 6, 0, 11, {'neovim'})
      local marks = vim.api.nvim_buf_get_extmarks(buf, ns, 0, -1, {})
      if #marks > 0 then return marks[1][3] else return -1 end
    `) as number;

    expect(col).toBe(0); // col 0 mark untouched by edit at col 6
  });
});

// ── Treesitter: AST-aware range detection ─────────────────────────────────────
//
// Pi uses treesitter to identify the exact line range of a function before
// extracting or rewriting it — no guesswork about where a function starts/ends.

describe("treesitter: function range detection for refactoring", () => {
  it("detects the start and end line of a Lua function definition", async () => {
    const tmp = tmpFile("ts_func");
    fs.writeFileSync(tmp, [
      "local M = {}",
      "",
      "function M.hello()",
      "  return 'world'",
      "end",
      "",
      "return M",
    ].join("\n") + "\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const range = await piClient.lua(`
        local buf    = ${bufnr}
        local parser = vim.treesitter.get_parser(buf, 'lua')
        if not parser then return nil end
        local tree   = parser:parse()[1]
        local root   = tree:root()
        local query  = vim.treesitter.query.parse('lua',
          '(function_declaration) @fn')
        for _, node in query:iter_captures(root, buf) do
          local sr, _, er, _ = node:range()
          return sr .. ':' .. er  -- 0-indexed start:end
        end
        return nil
      `) as string | null;

      expect(range).not.toBeNull();
      const [start, end_] = range!.split(":").map(Number);
      expect(start).toBe(2); // "function M.hello()" is line 2 (0-indexed)
      expect(end_).toBe(4);  // "end" is line 4 (0-indexed)
    } finally { rm(tmp); }
  });

  it("identifies multiple functions and their independent ranges", async () => {
    const tmp = tmpFile("ts_multi");
    fs.writeFileSync(tmp, [
      "local M = {}",
      "function M.first() return 1 end",
      "function M.second()",
      "  return 2",
      "end",
      "return M",
    ].join("\n") + "\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const count = await piClient.lua(`
        local buf    = ${bufnr}
        local parser = vim.treesitter.get_parser(buf, 'lua')
        if not parser then return 0 end
        local tree   = parser:parse()[1]
        local root   = tree:root()
        local query  = vim.treesitter.query.parse('lua',
          '(function_declaration) @fn')
        local n = 0
        for _ in query:iter_captures(root, buf) do n = n + 1 end
        return n
      `) as number;

      expect(count).toBe(2);
    } finally { rm(tmp); }
  });

  it("can extract a function's source lines given its treesitter range", async () => {
    const tmp = tmpFile("ts_extract");
    fs.writeFileSync(tmp, [
      "local M = {}",
      "function M.target()",
      "  local x = 1",
      "  return x + 1",
      "end",
      "return M",
    ].join("\n") + "\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const body = await piClient.lua(`
        local buf    = ${bufnr}
        local parser = vim.treesitter.get_parser(buf, 'lua')
        if not parser then return nil end
        local tree  = parser:parse()[1]
        local root  = tree:root()
        local query = vim.treesitter.query.parse('lua',
          '(function_declaration name: (dot_index_expression) @name) @fn')
        for id, node in query:iter_captures(root, buf) do
          local name = query.captures[id]
          if name == 'fn' then
            local sr, _, er, _ = node:range()
            local lines = vim.api.nvim_buf_get_lines(buf, sr, er + 1, false)
            return table.concat(lines, '\\n')
          end
        end
        return nil
      `) as string | null;

      expect(body).not.toBeNull();
      expect(body).toContain("function M.target()");
      expect(body).toContain("return x + 1");
      expect(body).toContain("end");
    } finally { rm(tmp); }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpFile(label: string): string {
  return path.join(os.tmpdir(), `pivi-ref-${label}-${Date.now()}.lua`);
}

function rm(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}
