/**
 * MockExtensionAPI — test harness for the pivi extension.
 *
 * Implements the ExtensionAPI surface that extension.ts calls. Tests can:
 *   1. Instantiate the extension by calling the default export with a MockExtensionAPI
 *   2. Simulate Pi lifecycle events (session_start, before_agent_start, context, tool_result)
 *   3. Inspect what tools were registered, what tools are active, what notifications fired
 *
 * This eliminates the need to import internal module state (liveState) directly.
 * Instead, tests drive the extension via its published API surface and observe
 * behaviour through its observable effects.
 *
 * Usage:
 *   const api = new MockExtensionAPI({ cwd: "/tmp", nvim: nvim.socketPath });
 *   await api.boot();                          // runs session_start
 *   await api.emitBeforeAgentStart();          // fires the hook
 *   await api.emitContext(messages);           // fires the context hook
 *   await api.emitToolResult("write", {...});  // fires tool_result
 *   api.tools                                  // registered tool specs
 *   api.activeTools                            // current tool set
 *   api.notifications                          // all ui.notify calls
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Minimal type mirrors (avoids importing Pi internals in tests) ─────────────

export interface MockMessage {
  role:        string;
  content:     string;
  customType?: string;
  display?:    boolean;
  [key: string]: unknown;
}

export interface MockToolSpec {
  name:        string;
  label?:      string;
  description: string;
  execute:     (id: string, args: Record<string, unknown>) => Promise<unknown>;
  [key: string]: unknown;
}

export interface MockNotification {
  message: string;
  level:   string;
}

export interface MockContextResult {
  messages?: MockMessage[];
}

export interface MockBeforeAgentStartResult {
  message?: {
    customType?: string;
    content:     string;
    display?:    boolean;
  };
  systemPrompt?: string;
}

// ── MockExtensionAPI ──────────────────────────────────────────────────────────

export interface MockExtensionAPIOptions {
  /** Current working directory (replaces ctx.cwd) */
  cwd?: string;
  /** $NVIM socket path (injected into process.env.NVIM during session_start) */
  nvim?: string;
}

export class MockExtensionAPI {
  // Recorded state
  readonly notifications: MockNotification[] = [];
  readonly tools:         MockToolSpec[]      = [];
  activeTools:            string[]            = [];

  // Stored handlers
  private readonly _handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();

  // Options
  private readonly _opts: MockExtensionAPIOptions;

  constructor(opts: MockExtensionAPIOptions = {}) {
    this._opts = opts;
  }

  // ── ExtensionAPI surface ────────────────────────────────────────────────────

  /** Minimal implementation of ExtensionAPI passed to the extension factory. */
  get api(): ExtensionAPI {
    const self = this;
    return {
      on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
        const list = self._handlers.get(event) ?? [];
        list.push(handler);
        self._handlers.set(event, list);
      },
      registerTool(spec: MockToolSpec) {
        self.tools.push(spec);
      },
      registerCommand(_name: string, _spec: unknown) {
        // no-op in tests — commands are Neovim-side UI, not relevant here
      },
      setActiveTools(names: string[]) {
        self.activeTools = names;
      },
      sendUserMessage(_text: string) {
        // no-op in tests
      },
      // Stub out the rest of ExtensionAPI so the type checker is happy
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as unknown as ExtensionAPI;
  }

  /** Mock ExtensionContext passed alongside events. */
  get ctx() {
    const self = this;
    return {
      cwd:  self._opts.cwd ?? process.cwd(),
      hasUI: false,
      isIdle: () => true,
      signal: undefined,
      abort:  () => {},
      hasPendingMessages: () => false,
      shutdown: () => {},
      getContextUsage: () => undefined,
      compact: () => {},
      getSystemPrompt: () => "",
      sessionManager: { getSessionFile: () => undefined },
      modelRegistry:  {},
      model: undefined,
      ui: {
        notify(message: string, level: string = "info") {
          self.notifications.push({ message, level });
        },
        confirm: async () => false,
        select:  async () => null,
        input:   async () => null,
        setStatus: () => {},
        setWidget:  () => {},
        custom:     async () => {},
      },
    };
  }

  // ── Simulation helpers ──────────────────────────────────────────────────────

  /**
   * Boot the extension: set process.env.NVIM if provided, fire session_start.
   * Returns after all session_start handlers complete.
   */
  async boot(): Promise<void> {
    const prevNvim = process.env.NVIM;
    if (this._opts.nvim) {
      process.env.NVIM = this._opts.nvim;
    }
    try {
      await this._emit("session_start", { type: "session_start", reason: "startup" });
    } finally {
      if (this._opts.nvim) {
        if (prevNvim === undefined) delete process.env.NVIM;
        else process.env.NVIM = prevNvim;
      }
    }
  }

  /** Simulate session_shutdown (cleanup). */
  async shutdown(): Promise<void> {
    await this._emit("session_shutdown", { type: "session_shutdown" });
  }

  /**
   * Simulate before_agent_start and return the combined result.
   * Returns the injected message (if any) or null.
   */
  async emitBeforeAgentStart(
    overrides: Partial<{ prompt: string; systemPrompt: string }> = {},
  ): Promise<MockBeforeAgentStartResult | undefined> {
    return this._emit("before_agent_start", {
      type:         "before_agent_start",
      prompt:       overrides.prompt       ?? "test prompt",
      systemPrompt: overrides.systemPrompt ?? "",
      systemPromptOptions: {},
    }) as Promise<MockBeforeAgentStartResult | undefined>;
  }

  /**
   * Simulate the context hook firing before an LLM call.
   * Returns the updated messages array (or the original if unchanged).
   */
  async emitContext(messages: MockMessage[]): Promise<MockMessage[]> {
    const result = await this._emit("context", {
      type:     "context",
      messages: messages,
    }) as MockContextResult | undefined;
    return result?.messages ?? messages;
  }

  /**
   * Simulate a tool_result event (e.g. after write or edit tool ran).
   */
  async emitToolResult(
    toolName: string,
    input:    Record<string, unknown>,
    opts:     { isError?: boolean } = {},
  ): Promise<void> {
    await this._emit("tool_result", {
      type:     "tool_result",
      toolName,
      input,
      isError:  opts.isError ?? false,
      output:   "",
    });
  }

  /**
   * Invoke a registered tool by name and return its result.
   */
  async invokeTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const spec = this.tools.find(t => t.name === name);
    if (!spec) throw new Error(`Tool "${name}" not registered`);
    return spec.execute("test-id", args);
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /** Emit an event to all registered handlers, returning the last non-undefined result. */
  private async _emit(event: string, payload: unknown): Promise<unknown> {
    const handlers = this._handlers.get(event) ?? [];
    let result: unknown;
    for (const h of handlers) {
      const r = await h(payload, this.ctx);
      if (r !== undefined) result = r;
    }
    return result;
  }
}

/**
 * Boot a fresh MockExtensionAPI with the pivi extension loaded.
 * Handles dynamic import of the default export and calls boot().
 *
 * @param opts - cwd and optional nvim socket path
 * @returns Tuple of [MockExtensionAPI, teardown function]
 */
export async function startPiviExtension(
  opts: MockExtensionAPIOptions = {},
): Promise<[MockExtensionAPI, () => Promise<void>]> {
  const api = new MockExtensionAPI(opts);

  // Dynamic import ensures a fresh module instance per test when needed
  const { default: piviFactory } = await import("../../extension.ts");
  piviFactory(api.api);

  await api.boot();

  return [
    api,
    async () => { await api.shutdown(); },
  ];
}
