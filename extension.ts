import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { NeovimClient } from "neovim";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { Type } from "@sinclair/typebox";

/**
 * pivi — Pi ↔ Neovim bridge extension
 *
 * Two surfaces:
 *
 * 1. SOCKET SERVER  (Neovim → Pi)
 *    Opens a Unix socket so the pivi.nvim Neovim plugin can inject prompts
 *    into the live Pi session.
 *
 * 2. NEOVIM TOOLS  (Pi → Neovim)
 *    Registers Neovim API functions as Pi tools, so Pi can drive the editor
 *    the same way it drives bash — open files, navigate, read diagnostics,
 *    edit buffers, and notify the user.
 *    Requires $NVIM to be set (Pi running inside a Neovim :terminal).
 *
 * Protocol (socket, newline-delimited JSON):
 *   → { "type": "prompt",  "message": "..." }
 *   → { "type": "ping" }
 *   ← { "ok": true }
 *   ← { "ok": true, "type": "pong" }
 *   ← { "ok": false, "error": "..." }
 */

// ── Module-level exports (consumed by tests and cursor-push handler) ────────

export interface CursorPos { file: string; line: number; col: number; }

export const liveState = {
  buffers:    new Map<number, string[]>(),
  cursor:     null as CursorPos | null,
  rpcChannel: null as number | null,
};

/**
 * Apply a nvim_buf_lines_event to a lines array.
 * firstLine/lastLine are 0-indexed; lastLine=-1 means end-of-buffer.
 */
export function applyLinesEvent(
  lines:     string[],
  firstLine: number,
  lastLine:  number,
  linedata:  string[],
): string[] {
  const end = lastLine === -1 ? lines.length : lastLine;
  return [...lines.slice(0, firstLine), ...linedata, ...lines.slice(end)];
}

// The Lua chunk extension.ts evaluates before every LLM call.
// test/helpers/live-state.ts keeps a reference copy; if they drift the
// nvim-context contract tests will catch it.
const CONTEXT_CHUNK = `return (function()
  local buf    = vim.api.nvim_get_current_buf()
  local name   = vim.api.nvim_buf_get_name(buf)
  if name == '' then return nil end
  local cursor = vim.api.nvim_win_get_cursor(0)
  local rel    = vim.fn.fnamemodify(name, ':.')
  local diags  = vim.diagnostic.get(buf)
  local parts  = { string.format('Neovim: %s  line %d col %d',
    rel, cursor[1], cursor[2] + 1) }
  if #diags > 0 then
    local sev = { 'ERROR', 'WARN', 'INFO', 'HINT' }
    for _, d in ipairs(diags) do
      table.insert(parts, string.format('  [%s] line %d: %s',
        sev[d.severity] or '?', d.lnum + 1, d.message))
    end
  end
  return table.concat(parts, '\\n')
end)()`;

// ── XDG socket paths ──────────────────────────────────────────────────────

const uid: string | number = typeof process.getuid === "function" ? process.getuid() : "unknown";
const _runtimeBase = process.env.XDG_RUNTIME_DIR ?? process.env.TMPDIR ?? `/tmp/pivi-${uid}`;
const SOCKETS_DIR = path.join(_runtimeBase, "pivi");
const LATEST_LINK = path.join(_runtimeBase, "pivi-latest.sock");

function cwdHash(cwd: string): string {
  return crypto.createHash("md5").update(cwd).digest("hex").slice(0, 12);
}

function socketPath(cwd: string): string {
  return path.join(SOCKETS_DIR, `${cwdHash(cwd)}-${process.pid}.sock`);
}

// ── Neovim client ─────────────────────────────────────────────────────────

interface NvimState {
  client: NeovimClient;
}

async function connectNvim(nvimSocket: string): Promise<NeovimClient> {
  const { attach } = await import("neovim");
  return attach({ socket: nvimSocket });
}

// ── Helpers ───────────────────────────────────────────────────────────────

const LEVEL_MAP = { info: 2, warning: 3, error: 4 } as const;

/** Resolve a file path to a buffer number, optionally opening it. */
async function resolveBuffer(nvim: NeovimClient, filePath: string | undefined): Promise<number> {
  if (!filePath) {
    return nvim.call("nvim_get_current_buf", []) as Promise<number>;
  }
  const abs = path.resolve(filePath);
  // Look for an existing buffer with this name
  const bufs = (await nvim.call("nvim_list_bufs", [])) as number[];
  for (const bufnr of bufs) {
    const name = (await nvim.call("nvim_buf_get_name", [bufnr])) as string;
    if (name === abs) return bufnr;
  }
  // Open the file
  await nvim.call("nvim_command", [`edit ${abs}`]);
  return nvim.call("nvim_get_current_buf", []) as Promise<number>;
}

// ── Extension ─────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let server: net.Server | null = null;
  let sockPath: string | null = null;
  let nvimState: NvimState | null = null;

  // ── Session start ────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    const cwd = ctx.cwd;

    // ── 1. Open pivi socket (Neovim → Pi injection) ──────────────────

    try {
      fs.mkdirSync(SOCKETS_DIR, { recursive: true });
    } catch {}

    sockPath = socketPath(cwd);
    try {
      fs.unlinkSync(sockPath);
    } catch {}

    server = net.createServer((conn) => {
      let buf = "";
      conn.on("data", (data) => {
        buf += data.toString();
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) handleSocketMessage(line, conn);
          nl = buf.indexOf("\n");
        }
      });
      conn.on("error", () => {});
    });

    server.listen(sockPath, () => {
      if (!sockPath) return;
      try {
        fs.unlinkSync(LATEST_LINK);
      } catch {}
      try {
        fs.symlinkSync(sockPath, LATEST_LINK);
      } catch {}
      try {
        fs.writeFileSync(
          `${sockPath}.info`,
          JSON.stringify({
            cwd,
            pid: process.pid,
            startedAt: new Date().toISOString(),
            nvim: process.env.NVIM ?? null,
          })
        );
      } catch {}
    });

    server.on("error", (err) => {
      ctx.ui.notify(`pivi socket error: ${err.message}`, "error");
    });

    // ── 2. Connect to Neovim RPC ($NVIM → Pi tools available) ────────

    const nvimSocket = process.env.NVIM;
    if (nvimSocket) {
      try {
        const client = await connectNvim(nvimSocket);
        nvimState = { client };

        // Probe which optional plugins are installed and ablate tools accordingly.
        // Pi only sees tools that will actually work in this session.
        const plugins = await client.lua(
          `return require('pivi.tools.probe').available()`
        ) as { aerial: boolean; neotest: boolean; overseer: boolean; dap: boolean };

        const activeTools = [
          // Core tools — always available (built-in Neovim API only)
          "nvim_lua", "nvim_buf_write", "nvim_buf_read",
          "nvim_open_file", "nvim_goto_location", "nvim_get_buffer",
          "nvim_set_lines", "nvim_get_diagnostics", "nvim_list_buffers",
          "nvim_run_command", "nvim_notify",
        ];
        if (plugins.aerial)   activeTools.push("nvim_get_symbols");
        if (plugins.neotest)  activeTools.push("nvim_run_tests");
        if (plugins.overseer) activeTools.push("nvim_run_task");
        if (plugins.dap)      activeTools.push("nvim_set_breakpoint", "nvim_get_variables");

        try { pi.setActiveTools(activeTools); } catch {}

        const extras = [
          plugins.aerial   && "aerial",
          plugins.neotest  && "neotest",
          plugins.overseer && "overseer",
          plugins.dap      && "dap",
        ].filter(Boolean).join(", ");

        // Get our msgpack-RPC channel ID so Neovim can push cursor events
        liveState.rpcChannel = await client.channelId;

        // Listen for cursor push notifications from pivi.nvim autocmds
        client.on("notification", (method: string, args: unknown[]) => {
          if (method !== "pivi_cursor") return;
          const p = args[0] as { file?: string; line?: number; col?: number };
          if (typeof p?.file !== "string" || typeof p?.line !== "number") return;
          liveState.cursor = { file: p.file, line: p.line, col: p.col ?? 1 };
        });

        ctx.ui.notify(
          extras
            ? `pivi: Neovim tools active (+${extras})`
            : "pivi: Neovim tools active",
          "info"
        );
      } catch (err) {
        ctx.ui.notify(`pivi: could not connect to Neovim RPC: ${err}`, "warning");
      }
    }
  });

  // ── Socket message handler ───────────────────────────────────────────

  function handleSocketMessage(raw: string, conn: net.Socket) {
    let msg: { type: string; message?: string };
    try {
      msg = JSON.parse(raw);
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      respond(conn, { ok: false, error: `parse error: ${detail}` });
      return;
    }

    if (msg.type === "ping") {
      respond(conn, { ok: true, type: "pong" });
      return;
    }

    if (msg.type === "prompt" && typeof msg.message === "string") {
      pi.sendUserMessage(msg.message);
      respond(conn, { ok: true });
      return;
    }

    respond(conn, { ok: false, error: `unknown message type: ${msg.type}` });
  }

  function respond(conn: net.Socket, obj: object) {
    try {
      conn.write(`${JSON.stringify(obj)}\n`);
    } catch {}
  }

  // ── Cleanup ──────────────────────────────────────────────────────────

  function cleanup() {
    if (server) {
      server.close();
      server = null;
    }
    if (!sockPath) return;
    try {
      fs.unlinkSync(sockPath);
    } catch {}
    try {
      fs.unlinkSync(`${sockPath}.info`);
    } catch {}
    try {
      if (fs.readlinkSync(LATEST_LINK) === sockPath) fs.unlinkSync(LATEST_LINK);
    } catch {}
    if (nvimState) {
      try {
        nvimState.client.quit();
      } catch {}
      nvimState = null;
    }
    liveState.buffers.clear();
    liveState.cursor     = null;
    liveState.rpcChannel = null;
  }

  pi.on("session_shutdown", async () => cleanup());
  process.on("exit", cleanup);

  // ── before_agent_start: inject live Neovim context ─────────────────────

  pi.on("before_agent_start", async (_event, ctx) => {
    if (!nvimState) return;
    try {
      const fresh = await nvimState.client.lua(CONTEXT_CHUNK) as string | null;
      if (!fresh) return;
      return {
        message: { role: "user", customType: "pivi-neovim-context", content: fresh, display: false },
      };
    } catch (e) {
      ctx.ui.notify(`pivi: context error — ${e instanceof Error ? e.message : String(e)}`, "warning");
    }
  });

  // ── context hook: refresh Neovim state before every LLM call ──────────────

  pi.on("context", async (event, ctx) => {
    if (!nvimState) return;
    const ev = event as { messages?: Array<{ customType?: string; content: string; role: string; display?: boolean }> };
    try {
      const fresh = await nvimState.client.lua(CONTEXT_CHUNK) as string | null;
      if (!fresh || !ev.messages) return;
      const cleaned = ev.messages.filter((m) => m.customType !== "pivi-neovim-context");
      return {
        messages: [
          ...cleaned,
          { role: "user", customType: "pivi-neovim-context", content: fresh, display: false },
        ],
      };
    } catch (e) {
      ctx.ui.notify(`pivi: context refresh error — ${e instanceof Error ? e.message : String(e)}`, "warning");
    }
  });

  // ── Slash command: info ───────────────────────────────────────────────

  pi.registerCommand("pivi-info", {
    description: "Show pivi socket path and Neovim connection status",
    handler: async (_args, ctx) => {
      const nvimLine = nvimState
        ? `Neovim tools: ✓ connected (${process.env.NVIM})`
        : "Neovim tools: ✗ not connected ($NVIM not set — run Pi inside :terminal)";
      ctx.ui.notify(`pivi socket: ${sockPath ?? "none"}\n${nvimLine}`, "info");
    },
  });

  // ══════════════════════════════════════════════════════════════════════
  // NEOVIM TOOLS — Pi drives the editor
  // Only registered when $NVIM is set and the client is connected.
  // ══════════════════════════════════════════════════════════════════════

  // ── nvim_open_file ───────────────────────────────────────────────────

  // ── nvim_lua ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_lua",
    label: "Neovim: execute Lua",
    description:
      "Evaluate arbitrary Lua in the live Neovim instance and return the result as a string. " +
      "The full vim.* API is available. Use vim.system() for shell commands. " +
      "Returns 'no Neovim session' when Pi is not running inside Neovim.",
    parameters: Type.Object({
      code: Type.String({ description: "Lua expression or do-block. Must return a value." }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return ok("no Neovim session");
      try {
        const result = await nvimState.client.lua(params.code as string);
        return ok(result != null ? String(result) : "");
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });

  // ── nvim_buf_write ────────────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_buf_write",
    label: "Neovim: write buffer",
    description:
      "Replace the entire content of a buffer identified by file path. " +
      "Opens the file if not already open. Does not write to disk.",
    parameters: Type.Object({
      path:    Type.String({ description: "Absolute or relative file path" }),
      content: Type.String({ description: "New content (newline-separated)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufnr = await resolveBuffer(nvimState.client, params.path as string);
        const lines  = (params.content as string).split("\n");
        if (lines.at(-1) === "") lines.pop();
        await nvimState.client.call("nvim_buf_set_lines", [bufnr, 0, -1, false, lines]);
        liveState.buffers.delete(bufnr);
        return ok(`wrote ${lines.length} lines to buffer ${bufnr}`);
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });

  // ── nvim_buf_read ─────────────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_buf_read",
    label: "Neovim: read buffer",
    description:
      "Return the current content of a buffer identified by file path. " +
      "Returns live in-memory content (unsaved changes included).",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative file path" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufnr = await resolveBuffer(nvimState.client, params.path as string);
        const lines  = await nvimState.client.call("nvim_buf_get_lines", [bufnr, 0, -1, false]) as string[];
        return ok(lines.join("\n"));
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });



  pi.registerTool({
    name: "nvim_open_file",
    label: "Neovim: open file",
    description:
      "Open a file in the Neovim editor and make it the active buffer. " +
      "Use this to navigate to a file before reading or editing it.",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute or relative path to the file" }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      if (!nvimState) return noNvim();
      try {
        const abs = path.resolve(params.path);
        await nvimState.client.call("nvim_command", [`edit ${abs}`]);
        const bufnr = (await nvimState.client.call("nvim_get_current_buf", [])) as number;
        const lineCount = (await nvimState.client.call("nvim_buf_line_count", [bufnr])) as number;
        return ok(`Opened ${abs} (${lineCount} lines)`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_goto_location ───────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_goto_location",
    label: "Neovim: go to location",
    description:
      "Navigate the Neovim cursor to a specific file and line. " +
      "Optionally specify a column (1-based). " +
      "Opens the file if it is not already loaded.",
    parameters: Type.Object({
      file: Type.String({ description: "File path to navigate to" }),
      line: Type.Number({ description: "Line number (1-based)" }),
      col: Type.Optional(Type.Number({ description: "Column number (1-based, default 1)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        await resolveBuffer(nvimState.client, params.file);
        const col = (params.col ?? 1) - 1; // nvim is 0-indexed for cols
        await nvimState.client.call("nvim_win_set_cursor", [0, [params.line, col]]);
        return ok(`Cursor at ${params.file}:${params.line}:${params.col ?? 1}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_get_buffer ──────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_get_buffer",
    label: "Neovim: get buffer content",
    description:
      "Read lines from a Neovim buffer. Returns the content with 1-based line numbers. " +
      "If no file is given, reads the current buffer. " +
      "Use start_line/end_line to read a specific range (1-based, inclusive).",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File path (default: current buffer)" })),
      start_line: Type.Optional(Type.Number({ description: "First line to read (1-based)" })),
      end_line: Type.Optional(
        Type.Number({ description: "Last line to read (1-based, -1 = end)" })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufnr = await resolveBuffer(nvimState.client, params.file);
        const start = (params.start_line ?? 1) - 1; // to 0-based
        const end = params.end_line === -1 || params.end_line === undefined ? -1 : params.end_line; // -1 = end in nvim API
        const lines = (await nvimState.client.call("nvim_buf_get_lines", [
          bufnr,
          start,
          end,
          false,
        ])) as string[];
        const numbered = lines
          .map((l, i) => `${(start + i + 1).toString().padStart(4)} ${l}`)
          .join("\n");
        return ok(numbered || "(empty)");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_set_lines ───────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_set_lines",
    label: "Neovim: set buffer lines",
    description:
      "Replace a range of lines in a Neovim buffer and save the file. " +
      "Lines are 1-based and inclusive. " +
      "To insert without replacing, set start_line == end_line + 1. " +
      "To delete lines, pass an empty lines array.",
    parameters: Type.Object({
      file: Type.String({ description: "File path to edit" }),
      start_line: Type.Number({ description: "First line to replace (1-based)" }),
      end_line: Type.Number({ description: "Last line to replace (1-based, inclusive)" }),
      lines: Type.Array(Type.String(), { description: "Replacement lines (empty array = delete)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufnr = await resolveBuffer(nvimState.client, params.file);
        await nvimState.client.call("nvim_buf_set_lines", [
          bufnr,
          params.start_line - 1, // 0-based start
          params.end_line, // exclusive end in nvim (so 1-based inclusive = pass as-is)
          false,
          params.lines,
        ]);
        await nvimState.client.call("nvim_command", ["write"]);
        return ok(
          `Replaced lines ${params.start_line}–${params.end_line} in ${params.file} ` +
            `with ${params.lines.length} line(s). File saved.`
        );
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_get_diagnostics ─────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_get_diagnostics",
    label: "Neovim: get diagnostics",
    description:
      "Get LSP diagnostics (errors, warnings, hints) for a file from Neovim. " +
      "If no file is given, returns diagnostics for the current buffer.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File path (default: current buffer)" })),
      severity: Type.Optional(
        Type.Union(
          [
            Type.Literal("error"),
            Type.Literal("warning"),
            Type.Literal("info"),
            Type.Literal("hint"),
          ],
          { description: "Filter by minimum severity (default: all)" }
        )
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufnr = await resolveBuffer(nvimState.client, params.file);
        const raw = (await nvimState.client.lua(`
        local diags = vim.diagnostic.get(${bufnr})
        local out = {}
        for _, d in ipairs(diags) do
          table.insert(out, {
            lnum = d.lnum + 1,
            col  = d.col + 1,
            severity = d.severity,
            message  = d.message,
            source   = d.source,
          })
        end
        return out
      `)) as Array<{
          lnum: number;
          col: number;
          severity: number;
          message: string;
          source?: string;
        }>;

        const SEV = ["", "ERROR", "WARN", "INFO", "HINT"];
        const minSev = params.severity
          ? { error: 1, warning: 2, info: 3, hint: 4 }[params.severity]
          : 4;

        const filtered = raw.filter((d) => d.severity <= (minSev ?? 4));
        if (!filtered.length) return ok("No diagnostics.");

        const text = filtered
          .map(
            (d) =>
              `  [${SEV[d.severity] ?? "?"}] ${d.lnum}:${d.col} ${d.message}${d.source ? ` (${d.source})` : ""}`
          )
          .join("\n");
        return ok(`${filtered.length} diagnostic(s):\n${text}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_get_symbols ─────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_get_symbols",
    label: "Neovim: get symbol outline",
    description:
      "Get the symbol outline (functions, classes, methods) for a file using aerial.nvim. " +
      "Returns a structured list of symbols with their line numbers. " +
      "Requires aerial.nvim to be installed.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File path (default: current buffer)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      await resolveBuffer(nvimState.client, params.file);
      try {
        const symbols = await nvimState.client.lua(
          `return require('pivi.tools.symbols').get()`
        ) as string | null;
        if (!symbols) return err("aerial.nvim not installed or no symbols found.");
        return ok(symbols || "(no symbols)");
      } catch {
        return err("Could not get symbols — is aerial.nvim installed?");
      }
    },
  });

  // ── nvim_list_buffers ────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_list_buffers",
    label: "Neovim: list open buffers",
    description: "List all files currently open in Neovim, with their buffer numbers.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const bufs = (await nvimState.client.call("nvim_list_bufs", [])) as number[];
        const lines: string[] = [];
        for (const bufnr of bufs) {
          const name = (await nvimState.client.call("nvim_buf_get_name", [bufnr])) as string;
          const loaded = (await nvimState.client.call("nvim_buf_is_loaded", [bufnr])) as boolean;
          if (loaded && name) {
            lines.push(`  [${bufnr}] ${name}`);
          }
        }
        return ok(lines.length ? lines.join("\n") : "(no open buffers)");
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_run_command ─────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_run_command",
    label: "Neovim: run ex command",
    description:
      "Run any Neovim ex command (like the : command line). " +
      "Examples: 'write', 'wall', 'checkhealth', 'LspRestart'. " +
      "Returns the command output if any.",
    parameters: Type.Object({
      command: Type.String({ description: "Ex command to run (without leading :)" }),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const result = (await nvimState.client.call("nvim_exec2", [
          params.command,
          { output: true },
        ])) as { output?: string };
        return ok(result.output?.trim() || `Ran: ${params.command}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── nvim_notify ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "nvim_notify",
    label: "Neovim: notify user",
    description:
      "Show a notification to the user inside Neovim. " +
      "Use this to report progress, completion, or errors without sending a chat message.",
    parameters: Type.Object({
      message: Type.String({ description: "Notification message" }),
      level: Type.Optional(
        Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")], {
          description: "Severity level (default: info)",
        })
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const level = LEVEL_MAP[params.level ?? "info"];
        await nvimState.client.call("nvim_notify", [params.message, level, {}]);
        return ok(`Notification sent: ${params.message}`);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  });

  // ── Soft-dep tools (registered always; guard inside Lua) ─────────────────
  // pcall(require, 'plugin') in Lua so Pi always sees the tool and gets a
  // clear "install X" message instead of a mystery failure.

  pi.registerTool({
    name: "nvim_run_tests",
    label: "Neovim: run tests (neotest)",
    description:
      "Run tests for a file via neotest and return structured pass/fail results. " +
      "Requires nvim-neotest/neotest + a language adapter (neotest-go, neotest-jest, etc.). " +
      "Returns passed count, failed count, and per-failure details.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File to test (default: current buffer)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const file = JSON.stringify(params.file ?? "");
        const raw = await nvimState.client.lua(
          `return require('pivi.tools.neotest').run_tests(${file})`
        ) as string;
        return ok(raw ?? "{}");
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });

  pi.registerTool({
    name: "nvim_run_task",
    label: "Neovim: run build task (overseer)",
    description:
      "Run a named build task via overseer.nvim (make, cargo, npm, vscode tasks) and return output. " +
      "Requires stevearc/overseer.nvim. Omit name to list available templates.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Task template name (omit to list available)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const name = JSON.stringify(params.name ?? "");
        const raw = await nvimState.client.lua(
          `return require('pivi.tools.overseer').run_task(${name})`
        ) as string;
        return ok(raw ?? "{}");
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });

  pi.registerTool({
    name: "nvim_set_breakpoint",
    label: "Neovim: toggle DAP breakpoint",
    description:
      "Toggle a debug breakpoint via nvim-dap. " +
      "Requires mfussenegger/nvim-dap. Omit file/line to toggle at cursor.",
    parameters: Type.Object({
      file: Type.Optional(Type.String({ description: "File path (default: current buffer)" })),
      line: Type.Optional(Type.Number({ description: "Line number 1-based (default: cursor)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const file = JSON.stringify(params.file ?? "");
        const line = params.line ?? 0;
        const raw = await nvimState.client.lua(
          `return require('pivi.tools.dap').toggle_breakpoint(${file}, ${line})`
        ) as string;
        return ok(raw ?? "{}");
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });

  pi.registerTool({
    name: "nvim_get_variables",
    label: "Neovim: get DAP local variables",
    description:
      "Read local variables from the current debug frame via nvim-dap. " +
      "Requires mfussenegger/nvim-dap and an active debug session. " +
      "Returns variable names, types, and values.",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      if (!nvimState) return noNvim();
      try {
        const raw = await nvimState.client.lua(
          `return require('pivi.tools.dap').get_variables()`
        ) as string;
        return ok(raw ?? "{}");
      } catch (e) { return err(e instanceof Error ? e.message : String(e)); }
    },
  });



  // ── Helpers ──────────────────────────────────────────────────────────

  function ok(text: string) {
    return { content: [{ type: "text" as const, text }], details: {} };
  }

  function err(text: string) {
    return {
      content: [{ type: "text" as const, text: `Error: ${text}` }],
      details: {},
      isError: true,
    };
  }

  function noNvim() {
    return err("$NVIM not set. Start Pi inside a Neovim :terminal to enable editor tools.");
  }
}
