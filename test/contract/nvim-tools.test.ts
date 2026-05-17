/**
 * Pi→Neovim tools — contract tests
 *
 * Consumer: Pi LLM agent (calls nvim_buf_write, nvim_buf_read, nvim_goto,
 *           nvim_diagnostics via the registered tools in extension.ts)
 * Provider: Neovim msgpack-RPC ($NVIM)
 *
 * Tests use a real headless Neovim and a test client acting as Pi.
 * Each test executes the same Lua/API sequence the tool would run
 * and asserts the resulting Neovim state.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";

const CWD = process.cwd();

let nvim:     NvimHarness;
let piClient: NeovimClient;  // simulates Pi's nvimClient

beforeEach(async () => {
  nvim     = await startNvim({ cwd: CWD });
  piClient = await attach({ socket: nvim.socketPath });
});

afterEach(() => {
  try { piClient.quit(); } catch {}
  nvim.close();
});

// ── Shared helpers ─────────────────────────────────────────────────────────

/** Look up a buffer number by file path, returns -1 if not open. */
async function bufnr(client: NeovimClient, filePath: string): Promise<number> {
  return client.lua(
    `return vim.fn.bufnr(vim.fn.fnamemodify(${JSON.stringify(filePath)}, ':p'))`,
  ) as Promise<number>;
}

/** Get all lines from an open buffer. */
async function getBufLines(client: NeovimClient, bufnrVal: number): Promise<string[]> {
  return client.call("nvim_buf_get_lines", [bufnrVal, 0, -1, false]) as Promise<string[]>;
}

// ── nvim_buf_write ─────────────────────────────────────────────────────────

describe("nvim_buf_write", () => {
  it("given the file is open: replaces buffer content in place without a disk write", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-bw-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "original\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      const buf = await bufnr(piClient, tmp);
      expect(buf).toBeGreaterThan(0);

      const newLines = ["modified by pi", "second line"];
      await piClient.call("nvim_buf_set_lines", [buf, 0, -1, false, newLines]);

      const lines = await getBufLines(nvim.client, buf);
      expect(lines).toEqual(["modified by pi", "second line"]);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given the file is not open: bufnr lookup returns -1 (tool should fall back to disk write)", async () => {
    const notOpen = "/tmp/pivi-never-opened.lua";
    const buf = await bufnr(piClient, notOpen);
    expect(buf).toBe(-1);
    // Tool should return 'file not open' message — buffer write skipped
  });

  it("given content with a trailing newline: all lines including the empty terminator are preserved", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-bw-ml-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);
      const buf = await bufnr(piClient, tmp);

      const lines = ["line one", "line two", "line three", ""];
      await piClient.call("nvim_buf_set_lines", [buf, 0, -1, false, lines]);

      const result = await getBufLines(nvim.client, buf);
      expect(result).toEqual(lines);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
});

// ── nvim_buf_read ──────────────────────────────────────────────────────────

describe("nvim_buf_read", () => {
  it("given an open buffer with unsaved changes: returns in-memory content, not disk content", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-br-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "disk content\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);
      const buf = await bufnr(piClient, tmp);

      // Mutate buffer in Neovim without touching disk
      await piClient.call("nvim_buf_set_lines", [buf, 0, -1, false, ["unsaved change"]]);

      // Read back via piClient (same as nvim_buf_read tool would)
      const lines = await piClient.call("nvim_buf_get_lines", [buf, 0, -1, false]) as string[];
      expect(lines).toEqual(["unsaved change"]);

      // Verify disk is unchanged (unsaved)
      const diskContent = fs.readFileSync(tmp, "utf-8");
      expect(diskContent).toBe("disk content\n");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given the file is not open: bufnr returns -1", async () => {
    const buf = await bufnr(piClient, "/tmp/pivi-no-such-buffer.lua");
    expect(buf).toBe(-1);
  });

  it("given a .lua file: filetype is 'lua'", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-br-ft-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "-- lua\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);
      const buf = await bufnr(piClient, tmp);
      const ft = await piClient.lua(`return vim.bo[${buf}].filetype or ''`);
      expect(ft).toBe("lua");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
});

// ── nvim_goto ──────────────────────────────────────────────────────────────

describe("nvim_goto", () => {
  it("given the file is already open: cursor lands on the requested line", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-gt-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "line1\nline2\nline3\nline4\nline5\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      // Pi navigates: fnameescape + edit + set_cursor
      const escaped = await piClient.lua(
        `return vim.fn.fnameescape(${JSON.stringify(tmp)})`,
      );
      await piClient.call("nvim_command", [`edit ${escaped}`]);
      const lineCount = await piClient.call("nvim_buf_line_count", [0]) as number;
      const target = Math.min(3, lineCount);
      await piClient.call("nvim_win_set_cursor", [0, [target, 0]]);

      const cursor = (await nvim.lua(
        "vim.api.nvim_win_get_cursor(0)",
      )) as [number, number];
      expect(cursor[0]).toBe(3);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a line number beyond the buffer end: cursor clamps to the last line", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-gt-clamp-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "only one line\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      const escaped = await piClient.lua(
        `return vim.fn.fnameescape(${JSON.stringify(tmp)})`,
      );
      await piClient.call("nvim_command", [`edit ${escaped}`]);
      const lineCount = await piClient.call("nvim_buf_line_count", [0]) as number;
      const clamped = Math.min(999, lineCount);
      await piClient.call("nvim_win_set_cursor", [0, [clamped, 0]]);

      const cursor = (await nvim.lua(
        "vim.api.nvim_win_get_cursor(0)",
      )) as [number, number];
      expect(cursor[0]).toBe(1); // only 1 line, clamped
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a path with spaces: fnameescape handles it without error", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pivi gt "));
    const tmp  = path.join(dir, "my file.lua");
    fs.writeFileSync(tmp, "content\n");
    try {
      const escaped = await piClient.lua(
        `return vim.fn.fnameescape(${JSON.stringify(tmp)})`,
      );
      // Must not throw — spaces handled
      await piClient.call("nvim_command", [`edit ${escaped}`]);
      const name = await nvim.lua("vim.api.nvim_buf_get_name(0)");
      expect(name).toContain("my file.lua");
    } finally {
      try { fs.rmSync(dir, { recursive: true }); } catch {}
    }
  });
});

// ── nvim_diagnostics ──────────────────────────────────────────────────────

describe("nvim_diagnostics", () => {
  it("given an ERROR diagnostic: returns '[ERROR] line N: message' format", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-diag-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "line1\nline2\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      // Inject a synthetic diagnostic
      await nvim.client.lua(`
        local ns = vim.api.nvim_create_namespace('pivi_tool_test')
        local buf = vim.fn.bufnr(vim.fn.fnamemodify('${tmp}', ':p'))
        vim.diagnostic.set(ns, buf, {
          { lnum = 1, col = 0, severity = vim.diagnostic.severity.ERROR,
            message = 'test error message' }
        })
      `);

      // Simulate nvim_diagnostics Lua chunk
      const result = await piClient.lua(`
        return (function()
          local p = vim.fn.fnamemodify(${JSON.stringify(tmp)}, ':p')
          local bufnr = vim.fn.bufnr(p)
          if bufnr == -1 then return 'buffer not open' end
          local diags = vim.diagnostic.get(bufnr)
          if #diags == 0 then return 'no diagnostics' end
          local sev = { 'ERROR', 'WARN', 'INFO', 'HINT' }
          local out = {}
          for _, d in ipairs(diags) do
            table.insert(out, string.format('[%s] line %d: %s',
              sev[d.severity] or '?', d.lnum + 1, d.message))
          end
          return table.concat(out, '\\n')
        end)()
      `);

      expect(result).toContain("[ERROR]");
      expect(result).toContain("line 2");
      expect(result).toContain("test error message");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given no diagnostics: returns the literal string 'no diagnostics'", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-diag-empty-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "clean\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      const result = await piClient.lua(`
        return (function()
          local p = vim.fn.fnamemodify(${JSON.stringify(tmp)}, ':p')
          local bufnr = vim.fn.bufnr(p)
          if bufnr == -1 then return 'buffer not open' end
          local diags = vim.diagnostic.get(bufnr)
          if #diags == 0 then return 'no diagnostics' end
          return 'has diagnostics'
        end)()
      `);

      expect(result).toBe("no diagnostics");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given the file is not open: returns 'buffer not open'", async () => {
    const result = await piClient.lua(`
      return (function()
        local p = vim.fn.fnamemodify('/tmp/pivi-not-open.lua', ':p')
        local bufnr = vim.fn.bufnr(p)
        if bufnr == -1 then return 'buffer not open' end
        return 'found'
      end)()
    `);
    expect(result).toBe("buffer not open");
  });
});
