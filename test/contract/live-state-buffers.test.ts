/**
 * liveState buffer tracking — contract tests (PIV-TSK-21)
 *
 * Consumer: context hook + nvim_buf_read (read from liveState, not RPC)
 * Provider: extension.ts — liveState.buffers maintained by buffer.listen()
 *
 * Two groups:
 *
 * Group 1 — applyLinesEvent (unit)
 *   The pure line-splice function that turns an nvim_buf_lines_event into an
 *   updated lines array. Tested independently of Neovim — no process needed.
 *
 * Group 2 — buffer tracking cycle (contract)
 *   buffer.listen() → callback fires → applyLinesEvent → liveState correct.
 *   Uses real headless Neovim via NvimHarness.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import { ATTACH } from "neovim/lib/api/Buffer";
import * as fs from "node:fs";
import * as path from "node:path";

// RED: applyLinesEvent does not exist yet in extension.ts.
// This import will fail until Green adds the named export.
import { applyLinesEvent } from "../../extension.ts";

import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { poll } from "../helpers/poll.ts";

const CWD = process.cwd();

// ── Group 1: applyLinesEvent — pure line-splice unit tests ────────────────────

describe("applyLinesEvent: splice lines array from nvim_buf_lines_event args", () => {
  it("single line replacement: firstLine=0 lastLine=1 linedata=['new'] → replaces first line", () => {
    const result = applyLinesEvent(["a", "b", "c"], 0, 1, ["new"]);
    expect(result).toEqual(["new", "b", "c"]);
  });

  it("line insertion: firstLine=1 lastLine=1 linedata=['inserted'] → inserts at index 1", () => {
    const result = applyLinesEvent(["a", "b", "c"], 1, 1, ["inserted"]);
    expect(result).toEqual(["a", "inserted", "b", "c"]);
  });

  it("line deletion: firstLine=1 lastLine=3 linedata=[] → removes lines 1 and 2", () => {
    const result = applyLinesEvent(["a", "b", "c", "d"], 1, 3, []);
    expect(result).toEqual(["a", "d"]);
  });

  it("full buffer replacement: firstLine=0 lastLine=-1 linedata=['x','y'] → replaces everything", () => {
    const result = applyLinesEvent(["a", "b", "c"], 0, -1, ["x", "y"]);
    expect(result).toEqual(["x", "y"]);
  });

  it("append at end: firstLine=N lastLine=N linedata=['z'] → appends", () => {
    const result = applyLinesEvent(["a", "b"], 2, 2, ["z"]);
    expect(result).toEqual(["a", "b", "z"]);
  });

  it("empty linedata with lastLine=-1 (full clear): result is empty array", () => {
    const result = applyLinesEvent(["a", "b", "c"], 0, -1, []);
    expect(result).toEqual([]);
  });

  it("multi-line replacement: firstLine=1 lastLine=3 linedata=['x','y'] → replaces lines 1-2 with two new", () => {
    const result = applyLinesEvent(["a", "b", "c", "d"], 1, 3, ["x", "y"]);
    expect(result).toEqual(["a", "x", "y", "d"]);
  });

  it("empty source + insert: firstLine=0 lastLine=0 linedata=['first'] → ['first']", () => {
    const result = applyLinesEvent([], 0, 0, ["first"]);
    expect(result).toEqual(["first"]);
  });
});

// ── Group 2: buffer tracking cycle ───────────────────────────────────────────

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

describe("liveState buffer tracking: listen() → applyLinesEvent → content current", () => {
  it("given buffer attached and edit made: liveState reflects edit without nvim_buf_get_lines", async () => {
    const tmp = tmpFile("track_edit");
    fs.writeFileSync(tmp, "original line\nsecond line\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      // Simulate extension.ts liveState setup
      const liveState = new Map<number, string[]>();
      const buf = (await piClient.buffers).find(b => b.id === bufnr)!;
      expect(buf).toBeDefined();

      await (buf as any)[ATTACH]();
      liveState.set(bufnr, await buf.lines); // initial content

      buf.listen("lines", (...args: unknown[]) => {
        const [, , firstLine, lastLine, linedata] = args as [unknown, unknown, number, number, string[]];
        liveState.set(bufnr, applyLinesEvent(liveState.get(bufnr) ?? [], firstLine, lastLine, linedata));
      });

      // Make edit via Neovim control client
      await nvim.client.call("nvim_buf_set_lines", [bufnr, 0, 1, false, ["changed line"]]);

      // liveState updates without any nvim_buf_get_lines call
      await poll(async () => liveState.get(bufnr)?.[0] === "changed line", 3000);

      expect(liveState.get(bufnr)).toEqual(["changed line", "second line"]);
    } finally { rm(tmp); }
  });

  it("given multiple sequential edits: liveState accumulates all changes correctly", async () => {
    const tmp = tmpFile("track_multi");
    fs.writeFileSync(tmp, "a\nb\nc\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const liveState = new Map<number, string[]>();
      const buf = (await piClient.buffers).find(b => b.id === bufnr)!;
      await (buf as any)[ATTACH]();
      liveState.set(bufnr, await buf.lines);

      buf.listen("lines", (...args: unknown[]) => {
        const [, , firstLine, lastLine, linedata] = args as [unknown, unknown, number, number, string[]];
        liveState.set(bufnr, applyLinesEvent(liveState.get(bufnr) ?? [], firstLine, lastLine, linedata));
      });

      await nvim.client.call("nvim_buf_set_lines", [bufnr, 0, 1, false, ["A"]]);
      await nvim.client.call("nvim_buf_set_lines", [bufnr, 2, 3, false, ["C"]]);

      await poll(async () => liveState.get(bufnr)?.[2] === "C", 3000);

      expect(liveState.get(bufnr)?.[0]).toBe("A");
      expect(liveState.get(bufnr)?.[1]).toBe("b");
      expect(liveState.get(bufnr)?.[2]).toBe("C");
    } finally { rm(tmp); }
  });

  it("given line inserted: liveState grows by one line", async () => {
    const tmp = tmpFile("track_insert");
    fs.writeFileSync(tmp, "line1\nline2\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const liveState = new Map<number, string[]>();
      const buf = (await piClient.buffers).find(b => b.id === bufnr)!;
      await (buf as any)[ATTACH]();
      const initial = await buf.lines;
      liveState.set(bufnr, initial);
      const startLen = initial.length;

      buf.listen("lines", (...args: unknown[]) => {
        const [, , firstLine, lastLine, linedata] = args as [unknown, unknown, number, number, string[]];
        liveState.set(bufnr, applyLinesEvent(liveState.get(bufnr) ?? [], firstLine, lastLine, linedata));
      });

      await nvim.client.call("nvim_buf_set_lines", [bufnr, 1, 1, false, ["inserted"]]);

      await poll(async () => (liveState.get(bufnr)?.length ?? 0) > startLen, 3000);

      expect(liveState.get(bufnr)).toContain("inserted");
      expect(liveState.get(bufnr)?.length).toBe(startLen + 1);
    } finally { rm(tmp); }
  });

  it("given non-existent bufnr: liveState lookup returns undefined (graceful no-op)", () => {
    const liveState = new Map<number, string[]>();
    const result = liveState.get(99999);
    expect(result).toBeUndefined();
    // graceful: no crash, applyLinesEvent uses ?? [] fallback
    const safe = applyLinesEvent(result ?? [], 0, -1, ["x"]);
    expect(safe).toEqual(["x"]);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpFile(label: string): string {
  return path.join(CWD, `_live_buf_${label}_${Date.now()}.lua`);
}

function rm(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}
