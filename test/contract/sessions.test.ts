/**
 * Session pinning — contract tests
 *
 * Consumer: Neovim user (selects a specific Pi session via :PiviSessions)
 * Provider: socket.lua (M.pinned routing logic)
 *
 * Contract: when the user pins a session, all subsequent sends go to that
 * session. Clearing the pin restores automatic cwd + version matching.
 * A stale pin (socket file deleted) is cleared automatically.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type MockPiServer, startMockPi } from "../helpers/pi-mock.ts";
import { type NvimHarness, startNvim } from "../helpers/nvim.ts";

const CWD = process.cwd();

let nvim:  NvimHarness;
let mockA: MockPiServer;
let mockB: MockPiServer;

beforeEach(async () => {
  nvim  = await startNvim({ cwd: CWD });
  mockA = await startMockPi(CWD, nvim.socketPath);
  mockB = await startMockPi(CWD, nvim.socketPath);
});

afterEach(() => {
  mockA.close();
  mockB.close();
  nvim.close();
});

describe("M.pinned — explicit session selection", () => {
  it("given a pinned socket, find() returns it regardless of cwd matching", async () => {
    await nvim.client.lua(
      `require('pivi.socket').pinned = '${mockB.socketPath}'`,
    );

    const found = await nvim.lua<string | null>("require('pivi.socket').find()");

    expect(found).toBe(mockB.socketPath);
  });

  it("given a pinned session, sends reach that session and not the auto-selected one", async () => {
    await nvim.client.lua(
      `require('pivi.socket').pinned = '${mockB.socketPath}'`,
    );

    await nvim.client.lua(
      "require('pivi.socket').send({type='ping'}, function() end)",
    );

    const msg = await mockB.waitForMessage("ping");

    expect(msg.type).toBe("ping");
    // mockA must have received nothing
    expect(mockA.messages).toHaveLength(0);
  });

  it("given pinned is cleared, routing falls back to cwd + version matching", async () => {
    // Pin to mockB, then clear
    await nvim.client.lua(`require('pivi.socket').pinned = '${mockB.socketPath}'`);
    await nvim.client.lua("require('pivi.socket').pinned = nil");

    // find() must no longer return mockB exclusively — it returns whichever
    // the automatic logic prefers (either mockA or mockB, both match cwd+ver)
    const found = await nvim.lua<string | null>("require('pivi.socket').find()");

    // The result must be one of the two valid sockets, not nil
    expect([mockA.socketPath, mockB.socketPath]).toContain(found);
  });

  it("given the pinned socket file is deleted, find() clears the pin and falls back to auto", async () => {
    await nvim.client.lua(
      `require('pivi.socket').pinned = '${mockB.socketPath}'`,
    );

    // Simulate mockB's Pi process dying (socket file disappears)
    mockB.close();

    const found = await nvim.lua<string | null>("require('pivi.socket').find()");

    // Must fall back to mockA; must NOT return the now-missing mockB socket
    expect(found).not.toBe(mockB.socketPath);
    expect(found).toBe(mockA.socketPath);

    // pinned must have been cleared by find()
    const pinned = await nvim.lua<string | null>(
      "require('pivi.socket').pinned",
    );
    expect(pinned).toBeNull();
  });
});
