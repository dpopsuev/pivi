/**
 * Neovim poweruser — contract tests
 *
 * Proves what only pivi can do: Pi has cursor position, live buffer content,
 * and active LSP diagnostics before the user types a word.
 *
 * Covers PIV-TSK-23 (navigation), PIV-TSK-24 (diagnostics),
 *         PIV-TSK-25 (test-driven loop), PIV-TSK-28 (ablation).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import {
  startPiviExtension,
  type MockExtensionAPI,
  type MockMessage,
} from "../helpers/pi-extension.ts";
import {
  parseContext,
  injectDiagnostics,
  setCursor,
} from "../helpers/live-state.ts";

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

// ── PIV-TSK-23: cursor position as context ────────────────────────────────────

describe("context injection: cursor position", () => {
  it("reports current file and line without the user stating them", async () => {
    const tmp = tmpFile("pos");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 6);
      const result = await api.emitBeforeAgentStart();

      const ctx = parseContext(result?.message?.content);
      expect(ctx?.line).toBe(6);
      expect(ctx?.file).toContain(path.basename(tmp));
      expect(result?.message?.display).toBe(false);
    } finally { rm(tmp); }
  });

  it("refreshes between LLM calls when the cursor moves", async () => {
    const tmp = tmpFile("move");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 3);
      const first = await api.emitBeforeAgentStart();
      expect(parseContext(first?.message?.content)?.line).toBe(3);

      // Pi navigates — cursor is now at line 8
      await nvim.client.lua(`vim.api.nvim_win_set_cursor(0, {8, 0})`);

      const messages: MockMessage[] = [
        { role: "user",  content: "help",                           display: true },
        { role: "user",  content: first!.message!.content,
          customType: "pivi-neovim-context",                        display: false },
      ];
      const refreshed = await api.emitContext(messages);
      const ctx = refreshed.find(m => m.customType === "pivi-neovim-context");

      expect(parseContext(ctx?.content)?.line).toBe(8);
    } finally { rm(tmp); }
  });

  it("injects nothing for scratch buffers", async () => {
    await nvim.client.lua(`
      local buf = vim.api.nvim_create_buf(false, true)
      vim.api.nvim_set_current_buf(buf)
    `);
    const result = await api.emitBeforeAgentStart();
    expect(result?.message).toBeUndefined();
  });

  it("reports col 1 when cursor is at column zero", async () => {
    const tmp = tmpFile("col");
    fs.writeFileSync(tmp, "hello world\n");
    try {
      await nvim.client.lua(`
        vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(tmp)}))
        vim.api.nvim_win_set_cursor(0, {1, 0})
      `);
      const result = await api.emitBeforeAgentStart();
      expect(parseContext(result?.message?.content)?.col).toBe(1);
    } finally { rm(tmp); }
  });
});

// ── PIV-TSK-24: LSP diagnostics as context ───────────────────────────────────

describe("context injection: LSP diagnostics", () => {
  it("includes active errors without the user pasting them", async () => {
    const tmp = tmpFile("err");
    fs.writeFileSync(tmp, "let x: number = 'wrong'\n");
    try {
      await setCursor(nvim.client, tmp, 1);
      const bufnr = await nvim.client.lua(
        `return vim.api.nvim_get_current_buf()`
      ) as number;

      await injectDiagnostics(nvim.client, bufnr, [
        { lnum: 0, col: 0, severity: 1,
          message: "Type 'string' is not assignable to type 'number'" },
      ]);

      const result = await api.emitBeforeAgentStart();
      expect(result?.message?.content).toContain("[ERROR]");
      expect(result?.message?.content).toContain(
        "Type 'string' is not assignable"
      );
    } finally { rm(tmp); }
  });

  it("captures unsaved change and diagnostic at the cursor — the zero-copy test", async () => {
    // User has cursor at line 45, an unsaved change with a bug, and a live
    // LSP error. They say nothing. Pi's context includes all three facts.
    const tmp = tmpFile("zero");
    fs.writeFileSync(
      tmp,
      Array.from({ length: 50 }, (_, i) => `-- line ${i + 1}`).join("\n") + "\n"
    );
    try {
      await setCursor(nvim.client, tmp, 45);
      const bufnr = await nvim.client.lua(
        `return vim.api.nvim_get_current_buf()`
      ) as number;

      // Unsaved change at line 45
      await nvim.client.call("nvim_buf_set_lines", [
        bufnr, 44, 45, false, ["let x: number = 'oops'"],
      ]);

      await injectDiagnostics(nvim.client, bufnr, [
        { lnum: 44, col: 0, severity: 1, message: "type mismatch" },
      ]);

      const result = await api.emitBeforeAgentStart();
      const ctx    = parseContext(result?.message?.content);

      expect(ctx?.line).toBe(45);
      expect(ctx?.file).toContain(path.basename(tmp));
      expect(ctx?.diagnostics[0].message).toBe("type mismatch");
      expect(ctx?.diagnostics[0].severity).toBe("ERROR");
    } finally { rm(tmp); }
  });

  it("includes all active diagnostics across severities", async () => {
    const tmp = tmpFile("multi");
    fs.writeFileSync(tmp, "a\nb\nc\nd\n");
    try {
      await setCursor(nvim.client, tmp, 1);
      const bufnr = await nvim.client.lua(
        `return vim.api.nvim_get_current_buf()`
      ) as number;

      await injectDiagnostics(nvim.client, bufnr, [
        { lnum: 0, col: 0, severity: 1, message: "error on line 1" },
        { lnum: 2, col: 0, severity: 2, message: "warning on line 3" },
        { lnum: 3, col: 0, severity: 1, message: "error on line 4" },
      ]);

      const result = await api.emitBeforeAgentStart();
      const ctx    = parseContext(result?.message?.content);

      expect(ctx?.diagnostics).toHaveLength(3);
      expect(ctx?.diagnostics.some(d => d.message === "error on line 1")).toBe(true);
      expect(ctx?.diagnostics.some(d => d.severity === "WARN")).toBe(true);
    } finally { rm(tmp); }
  });

  it("omits the diagnostic section when the buffer is clean", async () => {
    const tmp = tmpFile("clean");
    fs.writeFileSync(tmp, "-- clean file\n");
    try {
      await setCursor(nvim.client, tmp, 1);
      const result = await api.emitBeforeAgentStart();
      const content = result!.message!.content;

      expect(content).toContain("Neovim:");
      expect(content).not.toContain("[ERROR]");
      expect(content).not.toContain("[WARN]");
    } finally { rm(tmp); }
  });
});

// ── PIV-TSK-25: vim.system() as the test runner ───────────────────────────────

describe("nvim_lua: vim.system() as a shell surface", () => {
  it("captures stdout from a shell command", async () => {
    const r = await invokeLua(
      api,
      `return vim.system({'echo','pivi'},{text=true}):wait().stdout`
    );
    expect(r.trim()).toBe("pivi");
  });

  it("captures the exit code — non-zero signals failure", async () => {
    const r = await invokeLua(
      api,
      `return tostring(vim.system({'sh','-c','exit 1'},{text=true}):wait().code)`
    );
    expect(r.trim()).toBe("1");
  });

  it("captures stderr for failure diagnosis", async () => {
    const r = await invokeLua(
      api,
      `return vim.system({'sh','-c','echo fail >&2; exit 1'},{text=true}):wait().stderr or ''`
    );
    expect(r).toContain("fail");
  });

  it("composes a full test-run and result parse in a single call", async () => {
    const r = await invokeLua(api, `
      local obj = vim.system(
        {'sh','-c','echo "Tests: 3 passed" && exit 0'},
        {text=true, cwd=vim.fn.getcwd()}
      ):wait()
      if obj.code ~= 0 then return 'FAIL: ' .. (obj.stderr or '') end
      return 'PASS: ' .. (obj.stdout or '')
    `);
    expect(r).toContain("PASS");
    expect(r).toContain("Tests: 3 passed");
  });

  it("returns 'no Neovim session' when Pi is not inside Neovim", async () => {
    const [a, td] = await startPiviExtension({ cwd: CWD });
    try {
      const r = await invokeLua(a, `return "unreachable"`);
      expect(r).toBe("no Neovim session");
    } finally { await td(); }
  });
});

// ── PIV-TSK-28: ablation — context injection vs no injection ──────────────────

describe("ablation: context injection vs no Neovim connection", () => {
  it("without a Neovim connection: Pi receives no location context", async () => {
    const [a, td] = await startPiviExtension({ cwd: CWD });
    try {
      const result = await a.emitBeforeAgentStart();
      expect(result?.message).toBeUndefined();
    } finally { await td(); }
  });

  it("with a Neovim connection: Pi knows file and line before the user says anything", async () => {
    const tmp = tmpFile("abl");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 7);
      const result = await api.emitBeforeAgentStart();
      const ctx    = parseContext(result?.message?.content);

      expect(ctx?.file).toContain(path.basename(tmp));
      expect(ctx?.line).toBe(7);
    } finally { rm(tmp); }
  });

  it("named file: context injected; scratch buffer: nothing injected — measurable gap", async () => {
    // Proxy for the ablation:
    //   named file   = Pi is connected and can see the user's location
    //   scratch buffer = Pi cannot determine location (same as no NVIM in spirit)
    const tmp = tmpFile("gap");
    fs.writeFileSync(tmp, "-- target\n");
    try {
      // With a real file at cursor: Pi knows exactly where
      await setCursor(nvim.client, tmp, 1);
      const withCtx = await api.emitBeforeAgentStart();
      expect(withCtx?.message?.customType).toBe("pivi-neovim-context");
      expect(withCtx!.message!.content).toContain(path.basename(tmp));

      // Switch to scratch buffer: Pi can't determine location, injects nothing
      await nvim.client.lua(`
        local buf = vim.api.nvim_create_buf(false, true)
        vim.api.nvim_set_current_buf(buf)
      `);
      const noCtx = await api.emitBeforeAgentStart();
      expect(noCtx?.message).toBeUndefined();
    } finally { rm(tmp); }
  });

  it("context hook keeps Pi current across LLM calls; baseline is frozen at turn start", async () => {
    const tmp = tmpFile("hook");
    fs.writeFileSync(tmp, tenLines());
    try {
      await setCursor(nvim.client, tmp, 2);
      const initial = await api.emitBeforeAgentStart();

      // Pi navigates to line 9
      await nvim.client.lua(`vim.api.nvim_win_set_cursor(0, {9, 0})`);

      // With context hook: LLM call 2 gets line 9
      const msgs: MockMessage[] = [
        { role: "user", content: initial!.message!.content,
          customType: "pivi-neovim-context", display: false },
      ];
      const refreshed = await api.emitContext(msgs);
      const fresh = refreshed.find(m => m.customType === "pivi-neovim-context");
      expect(parseContext(fresh?.content)?.line).toBe(9);

      // Without hook: the stale snapshot from turn start stays at line 2
      expect(parseContext(msgs[0].content)?.line).toBe(2);
    } finally { rm(tmp); }
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpFile(label: string): string {
  return path.join(CWD, `_pwruser_${label}_${Date.now()}.lua`);
}

function tenLines(): string {
  return Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join("\n") + "\n";
}

function rm(p: string): void {
  try { fs.unlinkSync(p); } catch {}
}

async function invokeLua(a: MockExtensionAPI, code: string): Promise<string> {
  const r = await a.invokeTool("nvim_lua", { code }) as
    { content: Array<{ text: string }> };
  return r.content[0].text;
}
