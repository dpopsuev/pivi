/**
 * tool_result buffer sync — contract tests
 *
 * Consumer: Neovim user (buffer should reflect Pi's file writes immediately)
 * Provider: extension.ts tool_result hook + syncBuffer()
 *
 * Contract: when Pi's write or edit tools modify a file, the open Neovim
 * buffer reflects the change without requiring a :e or waiting for checktime.
 * When the file is not open, or the tool returned an error, no sync is attempted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";

const CWD = process.cwd();

// Mirrors the syncBuffer() function in extension.ts.
// Reads the current disk content and pushes it into the open Neovim buffer.
async function syncBuffer(
  client: NeovimClient,
  filePath: string,
): Promise<boolean> {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines   = content.split("\n");

    const bufnr = (await client.lua(
      `return vim.fn.bufnr(vim.fn.fnamemodify(${JSON.stringify(filePath)}, ':p'))`,
    )) as number;
    if (!bufnr || bufnr === -1) return false;

    await client.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);
    return true;
  } catch {
    return false;
  }
}

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

describe("syncBuffer — buffer sync after Pi file writes", () => {
  it("given the file is open: buffer reflects new disk content after sync", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-sync-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "original\n");

    try {
      // Open the file in Neovim
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      // Pi writes new content to disk (simulating write tool result)
      fs.writeFileSync(tmp, "written by pi\n");

      // Sync the open buffer
      const synced = await syncBuffer(piClient, tmp);
      expect(synced).toBe(true);

      // Assert buffer reflects new content
      const bufnr = await piClient.lua(
        `return vim.fn.bufnr(vim.fn.fnamemodify(${JSON.stringify(tmp)}, ':p'))`,
      );
      const lines = await nvim.client.call(
        "nvim_buf_get_lines", [bufnr, 0, -1, false],
      ) as string[];

      expect(lines.join("\n")).toContain("written by pi");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given the file is not open: syncBuffer returns false without error", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-sync-notopen-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "content\n");

    try {
      // Do NOT open the file in Neovim
      const synced = await syncBuffer(piClient, tmp);
      expect(synced).toBe(false);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a full write cycle: disk file and open buffer both contain the new content", async () => {
    const tmp = path.join(os.tmpdir(), `pivi-sync-both-${Date.now()}.lua`);
    fs.writeFileSync(tmp, "original\n");

    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      // Pi write tool: write to disk
      const newContent = "pi edit line 1\npi edit line 2\n";
      fs.writeFileSync(tmp, newContent);

      // Sync buffer
      await syncBuffer(piClient, tmp);

      // Verify disk
      expect(fs.readFileSync(tmp, "utf-8")).toBe(newContent);

      // Verify buffer
      const bufnr = await piClient.lua(
        `return vim.fn.bufnr(vim.fn.fnamemodify(${JSON.stringify(tmp)}, ':p'))`,
      );
      const lines = await nvim.client.call(
        "nvim_buf_get_lines", [bufnr, 0, -1, false],
      ) as string[];

      expect(lines).toContain("pi edit line 1");
      expect(lines).toContain("pi edit line 2");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a non-existent file path (isError: true equivalent): returns false without throwing", async () => {
    // Simulate isError: true — file was not actually written, so readFileSync throws
    const nonexistent = "/tmp/pivi-does-not-exist-xyz.lua";
    const synced = await syncBuffer(piClient, nonexistent);
    expect(synced).toBe(false);
    // Must not throw
  });
});
