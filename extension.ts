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
        ctx.ui.notify("pivi: Neovim tools active", "info");
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
      process.stdout.write("\x1b[?1049h\x1b[?1049l");
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
  }

  pi.on("session_shutdown", async () => cleanup());
  process.on("exit", cleanup);

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
        const symbols = (await nvimState.client.lua(`
          local ok, aerial = pcall(require, "aerial")
          if not ok then return nil end
          local items = aerial.get_location(true) or {}
          local out = {}
          for _, item in ipairs(items) do
            table.insert(out, string.format("%s%s (line %d)",
              string.rep("  ", (item.level or 1) - 1),
              item.name,
              item.lnum or 0
            ))
          end
          return table.concat(out, "\\n")
        `)) as string | null;

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
