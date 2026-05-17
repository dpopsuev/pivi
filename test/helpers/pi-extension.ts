/**
 * Pivi extension test helpers.
 *
 * Thin adapter over @earendil-works/pi-coding-agent/testing that adds
 * pivi-specific convenience methods (emitBeforeAgentStart, emitContext,
 * emitToolResult) on top of the generic ExtensionHarness surface.
 *
 * The hand-rolled MockExtensionAPI has been replaced by createExtensionHarness.
 * This file keeps the same external API so existing tests need no changes.
 */

import {
  createExtensionHarness,
  type ExtensionHarness,
  type HarnessNotification,
} from "@earendil-works/pi-coding-agent/testing";

// ── Pivi-specific types (kept for test compatibility) ─────────────────────────

export interface MockMessage {
  role:        string;
  content:     string;
  customType?: string;
  display?:    boolean;
  [key: string]: unknown;
}

export interface MockBeforeAgentStartResult {
  message?: {
    customType?: string;
    content:     string;
    display?:    boolean;
  };
  systemPrompt?: string;
}

export interface MockExtensionAPIOptions {
  cwd?:  string;
  /** $NVIM socket path — injected into process.env.NVIM for the session. */
  nvim?: string;
}

// Re-export so consumers that import MockNotification still compile.
export type MockNotification = HarnessNotification;

// ── MockExtensionAPI ──────────────────────────────────────────────────────────
//
// Delegates to ExtensionHarness; adds pivi-specific emit shorthands.

export class MockExtensionAPI {
  private readonly _h: ExtensionHarness;

  constructor(opts: MockExtensionAPIOptions = {}) {
    // Circular: we need the factory but MockExtensionAPI is constructed before
    // startPiviExtension calls boot(). Wire is done in startPiviExtension().
    // We create a stub harness here so the class exists; the real harness is
    // built in startPiviExtension and attached via _setHarness().
    throw new Error(
      "Use startPiviExtension() instead of constructing MockExtensionAPI directly.",
    );
    // (TypeScript requires the assignment even in dead code)
    this._h = null as unknown as ExtensionHarness;
  }

  /** @internal Used by startPiviExtension to inject the real harness. */
  static _wrap(h: ExtensionHarness): MockExtensionAPI {
    const self = Object.create(MockExtensionAPI.prototype) as MockExtensionAPI;
    (self as any)._h = h;
    return self;
  }

  // ── Observable state ────────────────────────────────────────────────────────

  get notifications(): HarnessNotification[] { return this._h.notifications; }
  get tools()        { return [...this._h.tools.values()]; }
  get activeTools()  { return this._h.activeTools; }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async boot():     Promise<void> { await this._h.boot(); }
  async shutdown(): Promise<void> { await this._h.shutdown(); }

  // ── Pivi-specific emit helpers ──────────────────────────────────────────────

  async emitBeforeAgentStart(
    overrides: Partial<{ prompt: string; systemPrompt: string }> = {},
  ): Promise<MockBeforeAgentStartResult | undefined> {
    return this._h.emit<MockBeforeAgentStartResult>("before_agent_start", {
      prompt:              overrides.prompt       ?? "test prompt",
      systemPrompt:        overrides.systemPrompt ?? "",
      systemPromptOptions: {},
    });
  }

  async emitContext(messages: MockMessage[]): Promise<MockMessage[]> {
    const result = await this._h.emit<{ messages?: MockMessage[] }>("context", { messages });
    return result?.messages ?? messages;
  }

  async emitToolResult(
    toolName: string,
    input:    Record<string, unknown>,
    opts:     { isError?: boolean } = {},
  ): Promise<void> {
    await this._h.emit("tool_result", {
      toolName,
      input,
      isError: opts.isError ?? false,
      output:  "",
    });
  }

  async invokeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this._h.invokeTool(name, args);
  }
}

// ── startPiviExtension ────────────────────────────────────────────────────────

/**
 * Boot the pivi extension inside a fresh harness.
 * Returns [api, teardown] — same shape as before.
 *
 * If opts.nvim is provided it is injected into process.env.NVIM for the
 * lifetime of the session and restored in teardown.
 */
export async function startPiviExtension(
  opts: MockExtensionAPIOptions = {},
): Promise<[MockExtensionAPI, () => Promise<void>]> {
  const { default: piviFactory } = await import("../../extension.ts");

  const h = createExtensionHarness(piviFactory, {
    cwd: opts.cwd,
    // Always set NVIM explicitly — undefined actively unsets it so a test
    // running without Neovim is not polluted by an outer session's env.
    env: { NVIM: opts.nvim },
  });

  await h.boot();

  const api = MockExtensionAPI._wrap(h);

  return [
    api,
    async () => { await h.shutdown(); },
  ];
}
