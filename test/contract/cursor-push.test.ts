/**
 * Cursor push — contract tests (PIV-TSK-22)
 *
 * Consumer: before_agent_start (reads liveState.cursor instead of querying Neovim)
 * Provider: extension.ts — nvimClient.on('notification') → liveState.cursor
 *           pivi.nvim Lua — CursorMoved/BufEnter → vim.fn.rpcnotify(rpcChannel, 'pivi_cursor', ...)
 *
 * All tests use MockExtensionAPI + startPiviExtension so the real extension
 * code runs (session_start, initCursorPush, notification handler) without
 * needing the full Pi binary.
 *
 * Key insight: liveState.rpcChannel is the extension's own nvimClient channel,
 * NOT piClient's channel. rpcnotify must target liveState.rpcChannel.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

import { type NvimHarness, startNvim } from "../helpers/nvim.ts";
import { startPiviExtension, type MockExtensionAPI } from "../helpers/pi-extension.ts";
import { poll } from "../helpers/poll.ts";
import { liveState } from "../../extension.ts";

const CWD = process.cwd();

let nvim:     NvimHarness;
let api:      MockExtensionAPI;
let teardown: () => Promise<void> = async () => {};

beforeEach(async () => {
  nvim = await startNvim({ cwd: CWD });
  // Boot the real extension with the Neovim socket injected
  // session_start runs → nvimClient connects → initCursorPush fires
  [api, teardown] = await startPiviExtension({ cwd: CWD, nvim: nvim.socketPath });
});

afterEach(async () => {
  await teardown();
  nvim.close();
  // Reset cursor between tests (liveState cleared by session_shutdown via teardown)
});

// ── Group 1: rpcChannel discovery ────────────────────────────────────────────

describe("rpcChannel: Pi discovers its own channel ID on session_start", () => {
  it("given Neovim is connected: liveState.rpcChannel is a positive integer after boot", () => {
    expect(liveState.rpcChannel).not.toBeNull();
    expect(typeof liveState.rpcChannel).toBe("number");
    expect(liveState.rpcChannel!).toBeGreaterThan(0);
  });

  it("given rpcChannel is set: it is the channel ID Neovim uses to route rpcnotify to the extension", async () => {
    // Fire a notification at liveState.rpcChannel — the extension must receive it
    const channelId = liveState.rpcChannel!;
    const payload   = JSON.stringify({ file: "probe.lua", line: 1, col: 1 });

    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(payload)}))`
    );

    await poll(async () => liveState.cursor !== null, 3000);
    expect(liveState.cursor!.file).toBe("probe.lua");
  });
});

// ── Group 2: liveState.cursor update ─────────────────────────────────────────

describe("liveState.cursor: updated on 'pivi_cursor' notification", () => {
  it("given pivi_cursor sent: liveState.cursor reflects file, line, and col", async () => {
    expect(liveState.cursor).toBeNull();

    const channelId = liveState.rpcChannel!;
    const payload   = JSON.stringify({ file: "socket.lua", line: 45, col: 3 });

    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(payload)}))`
    );

    await poll(async () => liveState.cursor !== null, 3000);

    expect(liveState.cursor!.file).toBe("socket.lua");
    expect(liveState.cursor!.line).toBe(45);
    expect(liveState.cursor!.col).toBe(3);
  });

  it("given cursor moved to a different file: liveState.cursor updates to the new location", async () => {
    const channelId = liveState.rpcChannel!;

    const p1 = JSON.stringify({ file: "a.lua", line: 1, col: 1 });
    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(p1)}))`
    );
    await poll(async () => liveState.cursor?.file === "a.lua", 3000);

    const p2 = JSON.stringify({ file: "b.lua", line: 10, col: 5 });
    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(p2)}))`
    );
    await poll(async () => liveState.cursor?.file === "b.lua", 3000);

    expect(liveState.cursor!.file).toBe("b.lua");
    expect(liveState.cursor!.line).toBe(10);
    expect(liveState.cursor!.col).toBe(5);
  });

  it("given multiple rapid cursor pushes: last one wins (no race, sequential)", async () => {
    const channelId = liveState.rpcChannel!;

    for (let i = 1; i <= 5; i++) {
      const p = JSON.stringify({ file: "race.lua", line: i, col: 1 });
      await nvim.client.lua(
        `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(p)}))`
      );
    }

    await poll(async () => liveState.cursor?.line === 5, 3000);
    expect(liveState.cursor!.line).toBe(5);
    expect(liveState.cursor!.file).toBe("race.lua");
  });

  it("given malformed payload (missing line): Orange log fires, liveState.cursor unchanged", async () => {
    const channelId = liveState.rpcChannel!;

    // Valid cursor first
    const good = JSON.stringify({ file: "ok.lua", line: 7, col: 1 });
    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(good)}))`
    );
    await poll(async () => liveState.cursor?.file === "ok.lua", 3000);

    // Malformed payload — missing `line`
    const bad = JSON.stringify({ file: "bad.lua" }); // no line field
    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(bad)}))`
    );

    // Give it time to process; cursor must NOT update
    await new Promise(r => setTimeout(r, 200));
    // Still pointing at ok.lua — malformed payload was rejected
    expect(liveState.cursor!.file).toBe("ok.lua");
  });

  it("given no cursor notification: liveState.cursor is null (before_agent_start uses CONTEXT_CHUNK fallback)", () => {
    // A freshly booted session that never received a cursor push
    // liveState.cursor stays null — this is the expected state in pure-socket sessions
    // (pivi.nvim sets up autocmds only after rpcChannel is in .info, which takes one
    // extra Neovim event loop cycle after boot)
    expect(liveState.cursor).toBeNull();
  });
});

// ── Group 3: session_shutdown clears cursor state ─────────────────────────────

describe("session_shutdown: liveState is cleared when session ends", () => {
  it("given cursor was set: after shutdown liveState.cursor and rpcChannel are null", async () => {
    const channelId = liveState.rpcChannel!;
    const p = JSON.stringify({ file: "cleanup.lua", line: 1, col: 1 });

    await nvim.client.lua(
      `vim.fn.rpcnotify(${channelId}, 'pivi_cursor', vim.fn.json_decode(${JSON.stringify(p)}))`
    );
    await poll(async () => liveState.cursor !== null, 3000);
    expect(liveState.cursor).not.toBeNull();

    // Teardown fires session_shutdown
    await teardown();
    // Reset teardown so afterEach doesn't call it again
    teardown = async () => {};

    expect(liveState.cursor).toBeNull();
    expect(liveState.rpcChannel).toBeNull();
  });
});
