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
    ["nvim_open_file",       { path: "/tmp/test.lua" }],
    ["nvim_goto_location",   { file: "/tmp/test.lua", line: 1 }],
    ["nvim_get_buffer",      { file: "/tmp/test.lua" }],
    ["nvim_set_lines",       { file: "/tmp/test.lua", start_line: 1, end_line: 1, lines: ["x"] }],
    ["nvim_get_diagnostics", {}],
    ["nvim_get_symbols",     {}],
    ["nvim_list_buffers",    {}],
    ["nvim_run_command",     { command: "echo hi" }],
    ["nvim_notify",          { message: "hello" }],
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

// ---------------------------------------------------------------------------
// Contract 2: all 9 tools are registered
// ---------------------------------------------------------------------------

describe("tool registration", () => {
  it("registers exactly the expected tool set", async () => {
    const { toolNames } = await bootTools();
    const expected = [
      "nvim_open_file",
      "nvim_goto_location",
      "nvim_get_buffer",
      "nvim_set_lines",
      "nvim_get_diagnostics",
      "nvim_get_symbols",
      "nvim_list_buffers",
      "nvim_run_command",
      "nvim_notify",
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
