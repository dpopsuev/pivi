/**
 * Live editor state — contract tests (PIV-TSK-29 — the forge)
 *
 * Three groups proving the mechanisms PIV-TSK-20 through PIV-TSK-22 depend on.
 *
 * Group 1 — CONTEXT_CHUNK freshness (foundation for PIV-TSK-20: context hook)
 *   CONTEXT_CHUNK always reflects the *current* Neovim state — not a stale
 *   snapshot from an earlier call.  PIV-TSK-20 wires this into `pi.on("context")`
 *   so it fires before every LLM call within a turn.
 *
 * Group 2 — buffer.listen() event delivery (foundation for PIV-TSK-21: liveState)
 *   @neovim/api routes nvim_buf_lines_event through the Buffer.listen() API,
 *   NOT through client.on('notification').  emitNotification() silently drops
 *   buffer events for buffers not registered in attachedBuffers.
 *
 *   Spike finding: use buffer.listen('lines', cb), not raw nvim_buf_attach.
 *   ATTACH symbol: import from 'neovim/lib/api/Buffer' to await the RPC.
 *
 * Group 3 — replaceContextMsg pure function
 *   The deduplication logic the context hook uses to replace the stale
 *   pivi-neovim-context message rather than accumulating duplicates.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attach, type NeovimClient } from "neovim";
// ATTACH is Symbol(attachBuffer) — lets us await nvim_buf_attach before listen()
import { ATTACH } from "neovim/lib/api/Buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { poll } from "../helpers/poll.ts";
import {
  CONTEXT_CHUNK,
  type ContextMessage,
  extractContextMsgs,
  injectDiagnostics,
  parseContext,
  replaceContextMsg,
  setCursor,
} from "../helpers/live-state.ts";

const CWD = process.cwd();

let nvim:     NvimHarness;
let piClient: NeovimClient; // simulates Pi extension's nvimClient

beforeEach(async () => {
  nvim     = await startNvim({ cwd: CWD });
  piClient = await attach({ socket: nvim.socketPath });
});

afterEach(() => {
  try { piClient.quit(); } catch {}
  nvim.close();
});

// ── Group 1: CONTEXT_CHUNK freshness ─────────────────────────────────────────

describe("CONTEXT_CHUNK: reflects current Neovim state, not a stale snapshot", () => {
  it("given cursor at line 3: parseContext returns line 3", async () => {
    const tmp = tmpFile("ctx_line");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 3);
      const ctx = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(ctx).not.toBeNull();
      expect(ctx!.line).toBe(3);
    } finally { rm(tmp); }
  });

  it("given cursor moves from line 3 to line 7: second call returns line 7, not line 3", async () => {
    const tmp = tmpFile("ctx_move");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 3);
      const first = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(first!.line).toBe(3);

      // Cursor moves — same as nvim_goto does between LLM calls within a turn
      await nvim.client.lua(`vim.api.nvim_win_set_cursor(0, {7, 0})`);

      const second = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(second!.line).toBe(7);
      expect(second!.line).not.toBe(first!.line);
    } finally { rm(tmp); }
  });

  it("given scratch buffer with no path: returns null (no injection)", async () => {
    await nvim.client.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_set_current_buf(buf)
    `);
    const result = await piClient.lua(CONTEXT_CHUNK) as string | null;
    expect(result).toBeNull();
  });

  it("given diagnostic appears after first call: second call includes the diagnostic", async () => {
    const tmp = tmpFile("ctx_diag");
    fs.writeFileSync(tmp, "line1\nline2\n");
    try {
      await setCursor(nvim.client, tmp, 1);
      const first = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(first!.diagnostics).toHaveLength(0);

      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;
      await injectDiagnostics(nvim.client, bufnr, [
        { lnum: 0, col: 0, severity: 1, message: "type mismatch" },
      ]);

      const second = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(second!.diagnostics).toHaveLength(1);
      expect(second!.diagnostics[0].message).toBe("type mismatch");
      expect(second!.diagnostics[0].severity).toBe("ERROR");
    } finally { rm(tmp); }
  });

  it("given cursor at col 0: col field is 1-indexed (col 1)", async () => {
    const tmp = tmpFile("ctx_col");
    fs.writeFileSync(tmp, "hello\n");
    try {
      await nvim.client.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))
        vim.api.nvim_win_set_cursor(0, {1, 0})
      `);
      const ctx = parseContext(await piClient.lua(CONTEXT_CHUNK) as string | null);
      expect(ctx!.col).toBe(1);
    } finally { rm(tmp); }
  });
});

// ── Group 2: buffer.listen() event delivery ───────────────────────────────────
//
// Spike finding: @neovim/api v5.4.0 routes nvim_buf_lines_event through
// Buffer.listen(), not client.on('notification').  emitNotification() silently
// drops buffer events for buffers absent from client.attachedBuffers.
//
// Correct API:
//   const buf = (await piClient.buffers).find(b => b.id === bufnr)
//   await buf[ATTACH]()          // await the nvim_buf_attach RPC first
//   buf.listen('lines', cb)       // register; sync, returns cleanup fn not Promise
//
// Callback signature: (buffer, changedtick, firstLine, lastLine, linedata, more)

describe("buffer.listen(): Neovim delivers buffer changes to the registered callback", () => {
  it("given listen('lines') registered: a line edit fires the callback with new content", async () => {
    const tmp = tmpFile("listen_edit");
    fs.writeFileSync(tmp, "original line\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const buf = (await piClient.buffers).find(b => b.id === bufnr);
      expect(buf).toBeDefined();

      // Await the nvim_buf_attach RPC before registering to avoid a race
      await (buf as any)[ATTACH]();

      const events: unknown[][] = [];
      buf!.listen("lines", (...args: unknown[]) => events.push(args));

      await nvim.client.call("nvim_buf_set_lines", [bufnr, 0, 1, false, ["changed line"]]);

      await poll(async () => events.length > 0, 3000);

      // linedata is arg[4] in the buf_lines_event signature
      const linedata = events[0][4] as string[];
      expect(linedata).toContain("changed line");
    } finally { rm(tmp); }
  });

  it("given listen('lines') registered: a line insertion fires with the inserted content", async () => {
    const tmp = tmpFile("listen_insert");
    fs.writeFileSync(tmp, "line1\nline2\nline3\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const buf = (await piClient.buffers).find(b => b.id === bufnr);
      expect(buf).toBeDefined();
      await (buf as any)[ATTACH]();

      const events: unknown[][] = [];
      buf!.listen("lines", (...args: unknown[]) => events.push(args));

      await nvim.client.call("nvim_buf_set_lines", [bufnr, 1, 1, false, ["inserted"]]);

      await poll(async () => events.length > 0, 3000);

      const linedata = events[0][4] as string[];
      expect(linedata).toContain("inserted");
    } finally { rm(tmp); }
  });

  it("given multiple edits: each edit fires a separate callback invocation", async () => {
    const tmp = tmpFile("listen_multi");
    fs.writeFileSync(tmp, "a\nb\nc\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const buf = (await piClient.buffers).find(b => b.id === bufnr);
      expect(buf).toBeDefined();
      await (buf as any)[ATTACH]();

      const events: unknown[][] = [];
      buf!.listen("lines", (...args: unknown[]) => events.push(args));

      await nvim.client.call("nvim_buf_set_lines", [bufnr, 0, 1, false, ["edit1"]]);
      await nvim.client.call("nvim_buf_set_lines", [bufnr, 1, 2, false, ["edit2"]]);

      await poll(async () => events.length >= 2, 3000);

      expect(events.length).toBeGreaterThanOrEqual(2);
    } finally { rm(tmp); }
  });

  it("initial buffer content is readable synchronously via buf.lines (PIV-TSK-21 uses this for initial state)", async () => {
    // sendBuffer=true via ATTACH is unusable with listen(): listen() calls
    // attachBuffer() synchronously making isAttached=true, so a subsequent
    // ATTACH(true) is a no-op. PIV-TSK-21's design: fetch initial content
    // via buf.lines (synchronous read), then use listen() for live updates.
    const tmp = tmpFile("initial_lines");
    fs.writeFileSync(tmp, "existing content\nsecond line\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const buf = (await piClient.buffers).find(b => b.id === bufnr);
      expect(buf).toBeDefined();

      // Synchronous read — no events needed
      const lines = await buf!.lines;
      expect(lines).toContain("existing content");
      expect(lines).toContain("second line");
    } finally { rm(tmp); }
  });

  it("buf.id equals the integer bufnr returned by nvim_get_current_buf (lookup pattern)", async () => {
    // PIV-TSK-21 locates the Buffer object by bufnr via:
    //   const buf = (await nvimClient.buffers).find(b => b.id === bufnr)
    // This test proves buf.id === the integer bufnr.
    const tmp = tmpFile("buf_id");
    fs.writeFileSync(tmp, "content\n");
    try {
      await nvim.client.lua(`vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))`);
      const bufnr = await nvim.client.lua(`return vim.api.nvim_get_current_buf()`) as number;

      const bufs = await piClient.buffers;
      const buf  = bufs.find(b => b.id === bufnr);

      expect(buf).toBeDefined();
      expect(buf!.id).toBe(bufnr);
    } finally { rm(tmp); }
  });
});

// ── Group 3: replaceContextMsg — deduplication pure function ──────────────────

describe("replaceContextMsg: deduplication logic for the context hook", () => {
  it("given no existing context message: appends the fresh message", () => {
    const msgs: ContextMessage[] = [
      { role: "user",      content: "fix my bug" },
      { role: "assistant", content: "I'll look at it" },
    ];
    const result = replaceContextMsg(msgs, "Neovim: socket.lua  line 45 col 1");
    expect(extractContextMsgs(result)).toHaveLength(1);
    expect(extractContextMsgs(result)[0].content).toContain("line 45");
  });

  it("given a stale context message: replaces it — not duplicated", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "fix my bug" },
      { role: "user", content: "Neovim: socket.lua  line 5 col 1", customType: "pivi-neovim-context" },
      { role: "assistant", content: "I'll look at it" },
    ];
    const result = replaceContextMsg(msgs, "Neovim: socket.lua  line 45 col 1");
    const ctxMsgs = extractContextMsgs(result);
    expect(ctxMsgs).toHaveLength(1);
    expect(ctxMsgs[0].content).toContain("line 45");
    expect(ctxMsgs[0].content).not.toContain("line 5");
  });

  it("given multiple stale context messages (degenerate state): collapses to exactly one fresh", () => {
    const msgs: ContextMessage[] = [
      { role: "user", content: "Neovim: a.lua  line 1 col 1", customType: "pivi-neovim-context" },
      { role: "user", content: "Neovim: b.lua  line 2 col 1", customType: "pivi-neovim-context" },
    ];
    const result = replaceContextMsg(msgs, "Neovim: socket.lua  line 45 col 1");
    expect(extractContextMsgs(result)).toHaveLength(1);
  });

  it("given a refresh: non-context messages are preserved in their original relative order", () => {
    const msgs: ContextMessage[] = [
      { role: "user",      content: "first message" },
      { role: "user",      content: "Neovim: old.lua  line 1 col 1", customType: "pivi-neovim-context" },
      { role: "assistant", content: "response" },
    ];
    const result = replaceContextMsg(msgs, "Neovim: new.lua  line 10 col 1");
    const nonCtx = result.filter(m => m.customType !== "pivi-neovim-context");
    expect(nonCtx).toHaveLength(2);
    expect(nonCtx[0].content).toBe("first message");
    expect(nonCtx[1].content).toBe("response");
  });

  it("given a fresh message: customType is pivi-neovim-context and display is false", () => {
    const result = replaceContextMsg([], "Neovim: socket.lua  line 1 col 1");
    const ctx = extractContextMsgs(result)[0];
    expect(ctx.customType).toBe("pivi-neovim-context");
    expect(ctx.display).toBe(false);
    expect(ctx.role).toBe("user");
  });
});

// ── Test utilities ────────────────────────────────────────────────────────────

function tmpFile(label: string): string {
  return path.join(CWD, `_live_state_${label}_${Date.now()}.lua`);
}

function tenLines(): string {
  return Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function rm(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}
