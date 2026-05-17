/**
 * Context assembly — contract tests
 *
 * Consumer: pivi.nvim (init.lua, context.lua)
 * Provider: Pi agent (mock socket server)
 *
 * Contract: prompts sent to Pi must include the active buffer's content,
 * its file path, and any active LSP diagnostics. Selection prompts must
 * include only the selected line range, not the whole file.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type MockPiServer, startMockPi } from "../helpers/pi-mock.ts";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";

const CWD = process.cwd();

let nvim: NvimHarness;
let mock: MockPiServer;
let tmpFile: string;

beforeEach(async () => {
  nvim  = await startNvim({ cwd: CWD });
  mock  = await startMockPi(CWD, nvim.socketPath);
  tmpFile = path.join(os.tmpdir(), `pivi-ctx-${Date.now()}.lua`);
  fs.writeFileSync(tmpFile, "line one\nline two\nline three\n");
});

afterEach(() => {
  mock.close();
  nvim.close();
  try { fs.unlinkSync(tmpFile); } catch {}
});

// ── M.ask() ───────────────────────────────────────────────────────────────

describe("M.ask() — full buffer context", () => {
  it("given an open buffer, Pi receives a fenced code block with its content", async () => {
    await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))`);
    await nvim.client.lua("require('pivi').ask('explain this')");

    const msg = await mock.waitForMessage("prompt");

    expect(msg.message).toContain("explain this");
    expect(msg.message).toContain("line one");
    expect(msg.message).toContain("line two");
    expect(msg.message).toContain("```lua");
  });

  it("given an open file, the file path appears in the context block", async () => {
    await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))`);
    await nvim.client.lua("require('pivi').ask('check this file')");

    const msg = await mock.waitForMessage("prompt");

    // fnamemodify(path, ":.") returns absolute path when outside cwd —
    // assert at least the basename is present
    expect(msg.message).toContain(path.basename(tmpFile));
  });

  it("given active LSP diagnostics, they are appended after the code block", async () => {
    await nvim.client.lua(`
      vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))
      local bufnr = vim.api.nvim_get_current_buf()
      local ns = vim.api.nvim_create_namespace('pivi_test_diags')
      vim.diagnostic.set(ns, bufnr, {
        { lnum = 0, col = 0, severity = vim.diagnostic.severity.ERROR,
          message = 'synthetic test error' }
      })
    `);

    await nvim.client.lua("require('pivi').ask('fix the error')");

    const msg = await mock.waitForMessage("prompt");

    expect(msg.message).toContain("LSP Diagnostics");
    expect(msg.message).toContain("[ERROR]");
    expect(msg.message).toContain("synthetic test error");
  });

  it("given no diagnostics, the message contains only the code block", async () => {
    await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))`);
    await nvim.client.lua("require('pivi').ask('review this')");

    const msg = await mock.waitForMessage("prompt");

    expect(msg.message).not.toContain("LSP Diagnostics");
  });
});

// ── M.ask_selection() ────────────────────────────────────────────────────

describe("M.ask_selection() — selection context", () => {
  it("given a visual selection, Pi receives only the selected lines", async () => {
    await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))`);

    // Enter visual-line mode, select lines 1–2, exit (sets '< and '> marks
    // and records 'V' as the last visual mode)
    await nvim.client.lua(`
      vim.api.nvim_feedkeys(
        vim.api.nvim_replace_termcodes('ggVj<Esc>', true, false, true),
        'x', true
      )
    `);

    await nvim.client.lua("require('pivi').ask_selection('explain selection')");

    const msg = await mock.waitForMessage("prompt");

    expect(msg.message).toContain("explain selection");
    expect(msg.message).toContain("line one");
    expect(msg.message).toContain("line two");
    // line three is outside the selection
    expect(msg.message).not.toContain("line three");
  });

  it("given a visual selection, the line range annotation is included in the context block", async () => {
    await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmpFile}'))`);

    await nvim.client.lua(`
      vim.api.nvim_feedkeys(
        vim.api.nvim_replace_termcodes('ggVj<Esc>', true, false, true),
        'x', true
      )
    `);

    await nvim.client.lua("require('pivi').ask_selection('what is this')");

    const msg = await mock.waitForMessage("prompt");

    // context.selection() formats as "File: … (lines N–M)"
    expect(msg.message).toMatch(/lines \d+[–-]\d+/);
  });
});
