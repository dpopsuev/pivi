/**
 * Tool execute() contract tests
 *
 * Every pivi tool must satisfy two properties:
 *
 *   1. Never throws — all errors become { content, isError } responses.
 *   2. Returns a content array when Neovim is not connected (noNvim path).
 *
 * These tests exercise the "no Neovim" path and "bad input" path
 * without requiring a live Neovim process.
 */

import { describe, it, expect } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import piviFactory from "../../extension.ts";
import { startPiviExtension } from "../helpers/pi-extension.ts";

// ---------------------------------------------------------------------------
// Minimal stub — captures all registered tool execute functions
// ---------------------------------------------------------------------------

async function bootTools() {
  const tools = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  const stubApi = {
    on: () => {},
    registerTool(spec: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
      tools.set(spec.name, spec.execute);
    },
    registerCommand: () => {},
    setActiveTools: () => {},
    sendUserMessage: () => {},
    ui: { notify: () => {} },
  } as unknown as ExtensionAPI;

  piviFactory(stubApi);

  return {
    invoke(name: string, params: Record<string, unknown> = {}) {
      const fn = tools.get(name);
      if (!fn) throw new Error(`Tool not registered: ${name}`);
      return fn("test-id", params, undefined, undefined, {});
    },
    toolNames: [...tools.keys()],
  };
}

// ---------------------------------------------------------------------------
// Contract 1: every tool returns content when Neovim is not connected
// ---------------------------------------------------------------------------

describe("tools: noNvim path returns content, never throws", () => {
  const testCases: Array<[string, Record<string, unknown>]> = [
    // nvim_lua returns ok (not error) when disconnected — it is the shell surface
    // and degrades with an informative message rather than an error signal.
    // Tested separately below.
    ["nvim_buf_write",      { path: "/tmp/test.lua", content: "x" }],
    ["nvim_buf_read",       { path: "/tmp/test.lua" }],
    ["nvim_buf_write",      { path: "/tmp/test.lua", content: "x" }],
    ["nvim_buf_read",       { path: "/tmp/test.lua" }],
    ["nvim_open_file",       { path: "/tmp/test.lua" }],
    ["nvim_goto_location",   { file: "/tmp/test.lua", line: 1 }],
    ["nvim_get_buffer",      { file: "/tmp/test.lua" }],
    ["nvim_set_lines",       { file: "/tmp/test.lua", start_line: 1, end_line: 1, lines: ["x"] }],
    ["nvim_get_diagnostics", {}],
    ["nvim_get_symbols",     {}],
    ["nvim_list_buffers",    {}],
    ["nvim_run_command",     { command: "echo hi" }],
    ["nvim_notify",          { message: "hello" }],
    // Soft-dep tools
    ["nvim_run_tests",       {}],
    ["nvim_run_task",        {}],
    ["nvim_set_breakpoint",  {}],
    ["nvim_get_variables",   {}],
    // Forge meta-tools
    ["pivi_forge_tool",      { name: "test", description: "test", lua: "return {}" }],
    ["pivi_list_tools",      {}],
    ["pivi_drop_tool",       { name: "test" }],
    ["nvim_lsp_wait",        { path: "/tmp/test.lua" }],
  ];

  for (const [toolName, params] of testCases) {
    it(`${toolName} returns content (not throw) when $NVIM is absent`, async () => {
      const { invoke } = await bootTools();
      // No Neovim connected — nvimState is null — must return err(), not throw
      const result = await invoke(toolName, params);
      expect(result).toHaveProperty("content");
      expect(Array.isArray((result as any).content)).toBe(true);
      expect((result as any).content[0]).toHaveProperty("text");
      // Should be an error response, not a success
      expect((result as any).isError).toBe(true);
    });
  }
});

// nvim_lua degrades to an informative message (not an error) when disconnected
describe("nvim_lua: disconnected behaviour", () => {
  it("returns 'no Neovim session' content (not isError) when $NVIM is absent", async () => {
    const [api, teardown] = await startPiviExtension({ cwd: "/tmp" }); // no nvim
    try {
      const result = await api.invokeTool("nvim_lua", { code: "return 1" }) as any;
      expect(result.content[0].text).toBe("no Neovim session");
      expect(result.isError ?? false).toBe(false);
    } finally { await teardown(); }
  });
});

// ---------------------------------------------------------------------------
// Contract 2: all 9 tools are registered
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("registers exactly the expected tool set", async () => {
    const { toolNames } = await bootTools();
    const expected = [
      // Tier 1 — core tools (always functional)
      "nvim_lua",
      "nvim_buf_write",
      "nvim_buf_read",
      "nvim_open_file",
      "nvim_goto_location",
      "nvim_get_buffer",
      "nvim_set_lines",
      "nvim_get_diagnostics",
      "nvim_get_symbols",
      "nvim_list_buffers",
      "nvim_run_command",
      "nvim_notify",
      // Tier 2 — soft-dep tools (registered always, functional when plugin present)
      "nvim_run_tests",
      "nvim_run_task",
      "nvim_set_breakpoint",
      "nvim_get_variables",
      // Tool forge meta-tools
      "pivi_forge_tool",
      "pivi_list_tools",
      "pivi_drop_tool",
      "nvim_lsp_wait",
    ];
    for (const name of expected) {
      expect(toolNames).toContain(name);
    }
    expect(toolNames).toHaveLength(expected.length);
  });
});

// ---------------------------------------------------------------------------
// Contract 3: return await — errors inside handlers are caught
// (tests that the try-catch + return await pattern works correctly)
// ---------------------------------------------------------------------------

describe("tools: connection-failure path returns content, never throws", () => {
  it("all tool execute() calls satisfy the no-throw contract", async () => {
    const { toolNames, invoke } = await bootTools();
    // With nvimState null, every tool must return without throwing
    await Promise.all(
      toolNames.map(async (name) => {
        const result = await invoke(name, {
          // Provide minimal valid params for each tool
          path: "/tmp/x", file: "/tmp/x", line: 1, start_line: 1, end_line: 1,
          lines: [], command: "echo", message: "x",
        });
        expect(result, `${name} must return content`).toHaveProperty("content");
      })
    );
  });
});
