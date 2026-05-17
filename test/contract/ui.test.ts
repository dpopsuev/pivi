/**
 * UI layer — contract tests
 *
 * Consumer: Neovim user (sees history pane, spinner)
 * Provider: pivi.ui (Lua module — ui.lua, init.lua)
 *
 * Covers three observable surfaces:
 *   - History buffer: conversation entries with You:/Pi: prefixes
 *   - Spinner:        winbar animation during processing; clean stop on finish
 *   - Quickfix:       removed — Pi writes buffers directly, no disk intermediary
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import { type MockPiServer, startMockPi } from "../helpers/pi-mock.ts";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { poll } from "../helpers/poll.ts";

const CWD = process.cwd();

// nvim.lua() prepends `return`, so multi-statement chunks must be IIFEs.

// Lua snippet: find the pivi://history buffer and return its lines.
const GET_HISTORY_LINES = `(function()
  local buf = nil
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(b) == 'pivi://history' then
      buf = b; break
    end
  end
  return buf and vim.api.nvim_buf_get_lines(buf, 0, -1, false) or {}
end)()`;

// Lua snippet: find the window showing pivi://history and return its winbar.
const GET_HISTORY_WINBAR = `(function()
  local history_buf, history_win = nil, nil
  for _, b in ipairs(vim.api.nvim_list_bufs()) do
    if vim.api.nvim_buf_get_name(b) == 'pivi://history' then
      history_buf = b; break
    end
  end
  if history_buf then
    for _, w in ipairs(vim.api.nvim_list_wins()) do
      if vim.api.nvim_win_get_buf(w) == history_buf then
        history_win = w; break
      end
    end
  end
  return history_win and vim.wo[history_win].winbar or ''
end)()`;

let nvim: NvimHarness;
let mock: MockPiServer;

beforeEach(async () => {
  nvim = await startNvim({ cwd: CWD });
  mock = await startMockPi(CWD, nvim.socketPath);
});

afterEach(() => {
  mock.close();
  nvim.close();
});

// ── History ───────────────────────────────────────────────────────────────

describe("history buffer", () => {
  it("given a user message, a 'You: ...' line appears in the history buffer", async () => {
    await nvim.client.lua("require('pivi.ui').open()");
    await nvim.client.lua("require('pivi.ui').append('you', 'hello world')");

    const lines = await nvim.lua<string[]>(GET_HISTORY_LINES);

    expect(lines.some(l => l.startsWith("You: hello world"))).toBe(true);
  });

  it("given a Pi response, a 'Pi:  ...' line appears in the history buffer", async () => {
    await nvim.client.lua("require('pivi.ui').open()");
    await nvim.client.lua("require('pivi.ui').append('pi', 'done ✓')");

    const lines = await nvim.lua<string[]>(GET_HISTORY_LINES);

    expect(lines.some(l => l.startsWith("Pi:  done ✓"))).toBe(true);
  });

  it("given two consecutive entries, a blank separator line appears between them", async () => {
    await nvim.client.lua("require('pivi.ui').open()");
    await nvim.client.lua("require('pivi.ui').append('you', 'first')");
    await nvim.client.lua("require('pivi.ui').append('pi',  'second')");

    const lines = await nvim.lua<string[]>(GET_HISTORY_LINES);
    const youIdx = lines.findIndex(l => l.startsWith("You: first"));
    const piIdx  = lines.findIndex(l => l.startsWith("Pi:  second"));

    expect(youIdx).toBeGreaterThanOrEqual(0);
    expect(piIdx).toBeGreaterThan(youIdx);
    // There must be at least one blank line between them
    const between = lines.slice(youIdx + 1, piIdx);
    expect(between.some(l => l.trim() === "")).toBe(true);
  });
});

// ── Spinner ───────────────────────────────────────────────────────────────

describe("spinner", () => {
  it("start_spinner replaces the status icon with an animated Braille frame", async () => {
    await nvim.client.lua("require('pivi.ui').open()");

    const before = await nvim.lua<string>(GET_HISTORY_WINBAR);

    await nvim.client.lua("require('pivi.ui').start_spinner()");
    // Give the 80 ms timer at least one tick
    await new Promise(r => setTimeout(r, 200));

    const during = await nvim.lua<string>(GET_HISTORY_WINBAR);

    // The spinner replaces the status icon with a Braille frame
    expect(during).not.toBe(before);
    // Braille spinner characters span U+2800; check for any of them
    expect(during).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
  });

  it("stop_spinner restores the status winbar, with no spinner frame remaining", async () => {
    await nvim.client.lua("require('pivi.ui').open()");
    await nvim.client.lua("require('pivi.ui').start_spinner()");
    await new Promise(r => setTimeout(r, 200));

    await nvim.client.lua("require('pivi.ui').stop_spinner()");
    await new Promise(r => setTimeout(r, 100));

    const after = await nvim.lua<string>(GET_HISTORY_WINBAR);

    // After stopping, the winbar shows a fixed status icon, not a spinner frame
    expect(after).not.toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u);
    // The pivi title is restored
    expect(after).toContain("π pivi");
  });
});
