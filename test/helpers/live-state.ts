/**
 * Live editor state — test helpers (PIV-TSK-29 — the forge).
 *
 * Provides the infrastructure that makes PIV-TSK-20 through PIV-TSK-28
 * testable without running the full Pi binary:
 *
 *  - CONTEXT_CHUNK        canonical Lua string (imported by context tests)
 *  - parseContext         structured form of the context message string
 *  - setCursor            position the cursor in a headless Neovim
 *  - injectDiagnostics    inject fake diagnostics into a buffer
 *  - extractContextMsgs   filter pivi-neovim-context from a messages array
 *  - replaceContextMsg    context hook deduplication logic as a pure function
 */

import type { NeovimClient } from "neovim";

// ── CONTEXT_CHUNK ─────────────────────────────────────────────────────────────
//
// The canonical Lua chunk that extension.ts sends to Neovim before every LLM
// call. This is the test-side reference: nvim-context.test.ts and
// live-state.test.ts import from here. extension.ts keeps its own inline copy.
// If they drift the context tests will fail — which is the intended contract.
//
export const CONTEXT_CHUNK = `return (function()
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

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ParsedContext {
  file: string;
  line: number;
  col:  number;
  diagnostics: Array<{ severity: string; line: number; message: string }>;
}

/** Minimal shape of a message as it appears in Pi's context array. */
export interface ContextMessage {
  role:        string;
  content:     string;
  customType?: string;
  display?:    boolean;
}

// ── Context string helpers ────────────────────────────────────────────────────

/**
 * Parse the string produced by CONTEXT_CHUNK into structured form.
 * Returns null when the string is null or doesn't match the header pattern.
 *
 * Header format:  "Neovim: <file>  line N col N"
 * Diagnostic fmt: "  [SEVERITY] line N: message"
 */
export function parseContext(text: string | null | undefined): ParsedContext | null {
  if (!text) return null;
  const lines = text.split("\n");
  const m = lines[0].match(/^Neovim: (.+?)\s{2}line (\d+) col (\d+)$/);
  if (!m) return null;

  const diagnostics: ParsedContext["diagnostics"] = [];
  for (const line of lines.slice(1)) {
    const d = line.match(/^\s+\[(\w+)\] line (\d+): (.+)$/);
    if (d) diagnostics.push({ severity: d[1], line: parseInt(d[2], 10), message: d[3] });
  }

  return { file: m[1], line: parseInt(m[2], 10), col: parseInt(m[3], 10), diagnostics };
}

// ── Neovim state helpers ──────────────────────────────────────────────────────

/**
 * Open a file and place the cursor at (line, col) using the given client.
 * line and col are 1-indexed (matching Neovim's human-facing convention).
 */
export async function setCursor(
  client:   NeovimClient,
  filePath: string,
  line:     number,
  col       = 1,
): Promise<void> {
  await client.lua(`
    vim.cmd('edit ' .. vim.fn.fnameescape(${JSON.stringify(filePath)}))
    vim.api.nvim_win_set_cursor(0, {${line}, ${col - 1}})
  `);
}

/**
 * Inject fake LSP diagnostics into a buffer via the pivi_test namespace.
 * Clears any previous pivi_test diagnostics on the buffer first — tests are isolated.
 *
 * severity: 1=ERROR 2=WARN 3=INFO 4=HINT  (vim.diagnostic.severity values)
 * lnum:     0-indexed line number
 * col:      0-indexed column (required by Neovim, defaults to 0)
 */
export async function injectDiagnostics(
  client: NeovimClient,
  bufnr:  number,
  diags:  Array<{ lnum: number; col?: number; severity: 1 | 2 | 3 | 4; message: string }>,
): Promise<void> {
  // Neovim requires col to be present — default to 0
  const normalised = diags.map(d => ({ col: 0, ...d }));
  const json = JSON.stringify(normalised);
  await client.lua(`
    local ns   = vim.api.nvim_create_namespace('pivi_test')
    local buf  = ${bufnr}
    local diag = vim.fn.json_decode(${JSON.stringify(json)})
    vim.diagnostic.reset(ns, buf)
    vim.diagnostic.set(ns, buf, diag)
  `);
}

// ── Context hook helpers ──────────────────────────────────────────────────────

/**
 * Extract all pivi-neovim-context messages from a context messages array.
 * Used to assert count and content after the context hook fires.
 */
export function extractContextMsgs(messages: unknown[]): ContextMessage[] {
  return messages.filter(
    (m): m is ContextMessage =>
      typeof m === "object" &&
      m !== null &&
      (m as ContextMessage).customType === "pivi-neovim-context",
  );
}

/**
 * Implement the context hook deduplication logic as a pure function.
 *
 * This is the exact algorithm PIV-TSK-20 adds to extension.ts:
 *   1. Remove any existing pivi-neovim-context message(s)
 *   2. Append one fresh message with the new content
 *   3. Never accumulate duplicates
 *
 * Non-context messages are preserved in their original relative order.
 */
export function replaceContextMsg(
  messages:     ContextMessage[],
  freshContent: string,
): ContextMessage[] {
  const cleaned = messages.filter((m) => m.customType !== "pivi-neovim-context");
  return [
    ...cleaned,
    { role: "user", content: freshContent, customType: "pivi-neovim-context", display: false },
  ];
}
