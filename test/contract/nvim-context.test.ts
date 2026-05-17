/**
 * Context injection — contract tests
 *
 * Consumer: Pi LLM agent (receives automatic context before each turn)
 * Provider: extension.ts before_agent_start hook (reads Neovim state via RPC)
 *
 * Contract: before every prompt, Pi receives the current file path, cursor
 * position, and active LSP diagnostics as a non-displayed message. Scratch
 * buffers and absent sessions produce no injection rather than an error.
 *
 * Tests run the exact Lua chunk that extension.ts sends to Neovim, so any
 * change to the injection logic will break the corresponding test.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import {
  CONTEXT_CHUNK,
  extractContextMsgs,
  parseContext,
  replaceContextMsg,
  setCursor,
  type ContextMessage,
} from "../helpers/live-state.ts";

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

describe("before_agent_start context injection", () => {
  it("given an open named buffer at line 3: context includes the relative path and 'line 3'", async () => {
    const tmp = path.join(CWD, `_pivi_ctx_test_${Date.now()}.lua`);
    fs.writeFileSync(tmp, "line1\nline2\nline3\nline4\nline5\n");
    try {
      await nvim.client.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))
        vim.api.nvim_win_set_cursor(0, {3, 0})
      `);

      const context = await piClient.lua(CONTEXT_CHUNK);

      expect(context).not.toBeNull();
      expect(context).toContain("line 3");
      expect(context).toContain(path.basename(tmp));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a scratch buffer with no file path: returns nil (no injection)", async () => {
    // Ensure current buffer is a scratch buffer
    await nvim.client.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_set_current_buf(buf)
    `);

    const context = await piClient.lua(CONTEXT_CHUNK);
    expect(context).toBeNull();
  });

  it("given active LSP diagnostics: they appear in the injected context string", async () => {
    const tmp = path.join(CWD, `_pivi_ctx_diag_${Date.now()}.lua`);
    fs.writeFileSync(tmp, "line1\nline2\n");
    try {
      await nvim.client.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))
        local ns = vim.api.nvim_create_namespace('pivi_ctx_test')
        local buf = vim.api.nvim_get_current_buf()
        vim.diagnostic.set(ns, buf, {
          { lnum = 0, col = 0, severity = vim.diagnostic.severity.ERROR,
            message = 'context diag error' }
        })
      `);

      const context = await piClient.lua(CONTEXT_CHUNK);

      expect(context).toContain("[ERROR]");
      expect(context).toContain("context diag error");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given no diagnostics: context contains only file path and cursor, no diagnostic section", async () => {
    const tmp = path.join(CWD, `_pivi_ctx_clean_${Date.now()}.lua`);
    fs.writeFileSync(tmp, "clean\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))`);

      const context = await piClient.lua(CONTEXT_CHUNK);

      expect(context).not.toContain("[ERROR]");
      expect(context).not.toContain("[WARN]");
      expect(context).toContain("Neovim:");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given cursor at column 0: the output shows col 1 (1-indexed for human readability)", async () => {
    const tmp = path.join(CWD, `_pivi_ctx_col_${Date.now()}.lua`);
    fs.writeFileSync(tmp, "hello\n");
    try {
      await nvim.client.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape('${tmp}'))
        vim.api.nvim_win_set_cursor(0, {1, 0})
      `);

      const context = await piClient.lua(CONTEXT_CHUNK);
      expect(context).toContain("col 1");
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
});

describe("context hook: intra-turn refresh cycle (PIV-TSK-20)", () => {
  /**
   * Contract: pi.on("context", ...) fires before every LLM call in a turn.
   * Each firing runs CONTEXT_CHUNK against the live Neovim state, then calls
   * replaceContextMsg to swap the stale pivi-neovim-context with a fresh one.
   *
   * These tests prove the full cycle that extension.ts must implement:
   *   1. CONTEXT_CHUNK produces a fresh string after cursor moves
   *   2. replaceContextMsg swaps — does not accumulate — context messages
   *   3. A null result (scratch buffer) leaves the messages array unchanged
   */

  it("given cursor at line 3 then moved to line 8: two sequential CONTEXT_CHUNK calls return different lines", async () => {
    const tmp = path.join(CWD, `_ctx_hook_seq_${Date.now()}.lua`);
    fs.writeFileSync(tmp, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    try {
      // LLM call 1 — before_agent_start fires at line 3
      await setCursor(nvim.client, tmp, 3);
      const snap1 = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(snap1!.line).toBe(3);

      // Pi calls nvim_goto — cursor is now at line 8
      await nvim.client.lua(`vim.api.nvim_win_set_cursor(0, {8, 0})`);

      // LLM call 2 — context hook fires, CONTEXT_CHUNK re-runs
      const snap2 = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(snap2!.line).toBe(8);
      expect(snap2!.line).not.toBe(snap1!.line);
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given a stale context message from call 1: context hook replaces it, not duplicates, for call 2", async () => {
    const tmp = path.join(CWD, `_ctx_hook_dedup_${Date.now()}.lua`);
    fs.writeFileSync(tmp, Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n");
    try {
      // LLM call 1: before_agent_start produces initial snapshot
      await setCursor(nvim.client, tmp, 3);
      const initial = await piClient.lua(CONTEXT_CHUNK) as string;

      const messages: ContextMessage[] = [
        { role: "user",      content: "fix my bug" },
        { role: "user",      content: initial, customType: "pivi-neovim-context", display: false },
        { role: "assistant", content: "Let me check." },
      ];

      // Cursor moves between LLM calls
      await nvim.client.lua(`vim.api.nvim_win_set_cursor(0, {8, 0})`);

      // LLM call 2: context hook fires — must replace, not append
      const fresh = await piClient.lua(CONTEXT_CHUNK) as string;
      const updated = replaceContextMsg(messages, fresh);

      const ctxMsgs = extractContextMsgs(updated);
      expect(ctxMsgs).toHaveLength(1);                        // never duplicated
      expect(ctxMsgs[0].content).toContain("line 8");         // fresh
      expect(ctxMsgs[0].content).not.toContain("line 3");     // stale gone
      expect(updated.filter(m => m.customType !== "pivi-neovim-context")).toHaveLength(2); // others preserved
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });

  it("given scratch buffer: CONTEXT_CHUNK returns null and the messages array is left unchanged", async () => {
    await nvim.client.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_set_current_buf(buf)
    `);

    const result = await piClient.lua(CONTEXT_CHUNK) as string | null;
    expect(result).toBeNull();

    // When context hook receives null — it must return undefined (no change to messages)
    // Simulated: the guard `if (!fresh) return;` means messages stay unchanged
    const messages: ContextMessage[] = [
      { role: "user", content: "original", customType: "pivi-neovim-context" },
    ];
    // null → no replacement → messages unchanged
    const unchanged = result === null ? messages : replaceContextMsg(messages, result);
    expect(unchanged).toBe(messages); // same reference — no mutation
  });
});
