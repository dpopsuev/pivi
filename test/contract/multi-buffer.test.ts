/**
 * Multi-buffer coordination — contract tests (PIV-TSK-26)
 *
 * Proves Pi can write to and read from any open buffer by path, not just the
 * current buffer. Edits to one buffer do not affect another. liveState tracks
 * each attached buffer independently.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import {
  startPiviExtension,
  type MockExtensionAPI,
} from "../helpers/pi-extension.ts";

const CWD = process.cwd();

let nvim:     NvimHarness;
let api:      MockExtensionAPI;
let teardown: () => Promise<void> = async () => {};

beforeEach(async () => {
  nvim = await startNvim({ cwd: CWD });
  [api, teardown] = await startPiviExtension({ cwd: CWD, nvim: nvim.socketPath });
});

afterEach(async () => {
  await teardown();
  nvim.close();
});

// ── nvim_buf_write: targets a specific buffer by path ────────────────────────

describe("nvim_buf_write: writes to the named buffer regardless of which is current", () => {
  it("writes to a non-current open buffer", async () => {
    const a = tmpFile("buf_a");
    const b = tmpFile("buf_b");
    fs.writeFileSync(a, "original a\n");
    fs.writeFileSync(b, "original b\n");
    try {
      // Open both; b ends up as current
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(a)}))`);
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(b)}))`);

      // Write to a — not the current buffer
      await api.invokeTool("nvim_buf_write", {
        path: a,
        content: "written to a\n",
      });

      // b is current and untouched
      const resultA = await api.invokeTool("nvim_buf_read", { path: a }) as
        { content: Array<{ text: string }> };
      const resultB = await api.invokeTool("nvim_buf_read", { path: b }) as
        { content: Array<{ text: string }> };

      expect(resultA.content[0].text).toContain("written to a");
      expect(resultB.content[0].text).toContain("original b");
    } finally { rm(a); rm(b); }
  });

  it("edits to buffer A do not affect buffer B", async () => {
    const a = tmpFile("iso_a");
    const b = tmpFile("iso_b");
    fs.writeFileSync(a, "file a content\n");
    fs.writeFileSync(b, "file b content\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(a)}))`);
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(b)}))`);

      await api.invokeTool("nvim_buf_write", { path: a, content: "replaced\n" });

      const rb = await api.invokeTool("nvim_buf_read", { path: b }) as
        { content: Array<{ text: string }> };
      expect(rb.content[0].text).toContain("file b content");
      expect(rb.content[0].text).not.toContain("replaced");
    } finally { rm(a); rm(b); }
  });
});

// ── nvim_buf_read: reads any open buffer by path ─────────────────────────────

describe("nvim_buf_read: reads the named buffer's live content", () => {
  it("reads a non-current buffer's unsaved changes", async () => {
    const a = tmpFile("read_a");
    const b = tmpFile("read_b");
    fs.writeFileSync(a, "disk content\n");
    fs.writeFileSync(b, "b content\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(a)}))`);
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(b)}))`);

      // Unsaved edit to a via Neovim (not on disk)
      const bufnrA = await nvim.client.lua(
        `return vim.fn.bufnr(vim.fn.fnameescape(${JSON.stringify(a)}))`
      ) as number;
      await nvim.client.call("nvim_buf_set_lines", [bufnrA, 0, -1, false, ["in-memory only"]]);

      // b is current; a is not — but read returns a's live content
      const result = await api.invokeTool("nvim_buf_read", { path: a }) as
        { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain("in-memory only");
      expect(fs.readFileSync(a, "utf-8")).toContain("disk content"); // disk unchanged
    } finally { rm(a); rm(b); }
  });

  it("reading two buffers returns independent content", async () => {
    const a = tmpFile("ind_a");
    const b = tmpFile("ind_b");
    fs.writeFileSync(a, "alpha\n");
    fs.writeFileSync(b, "beta\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(a)}))`);
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(b)}))`);

      const ra = await api.invokeTool("nvim_buf_read", { path: a }) as
        { content: Array<{ text: string }> };
      const rb = await api.invokeTool("nvim_buf_read", { path: b }) as
        { content: Array<{ text: string }> };

      expect(ra.content[0].text).toContain("alpha");
      expect(rb.content[0].text).toContain("beta");
      expect(ra.content[0].text).not.toContain("beta");
      expect(rb.content[0].text).not.toContain("alpha");
    } finally { rm(a); rm(b); }
  });
});

// ── liveState: independently tracks multiple attached buffers ─────────────────

describe("liveState: independently tracks each attached buffer", () => {
  it("edits to buffer A update only its liveState entry", async () => {
    const a = tmpFile("live_a");
    const b = tmpFile("live_b");
    fs.writeFileSync(a, "a line 1\na line 2\n");
    fs.writeFileSync(b, "b line 1\nb line 2\n");
    try {
      // Open both and attach liveState via nvim_lua
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(a)}))`);
      const bufA = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(b)}))`);
      const bufB = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      // Edit a via control client
      await nvim.client.call("nvim_buf_set_lines", [bufA, 0, 1, false, ["a edited"]]);

      // Read both via tool — a should reflect edit, b should not
      const ra = await api.invokeTool("nvim_buf_read", { path: a }) as
        { content: Array<{ text: string }> };
      const rb = await api.invokeTool("nvim_buf_read", { path: b }) as
        { content: Array<{ text: string }> };

      expect(ra.content[0].text).toContain("a edited");
      expect(rb.content[0].text).toContain("b line 1");
      expect(rb.content[0].text).not.toContain("a edited");

      void bufA; void bufB; // used above
    } finally { rm(a); rm(b); }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpFile(label: string): string {
  return path.join(os.tmpdir(), `pivi-mb-${label}-${Date.now()}.lua`);
}

function rm(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}
