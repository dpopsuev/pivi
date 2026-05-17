--- pivi.context — Build context strings to inject into Pi prompts.

local M = {}

--- Return the relative path of a buffer, or nil if it has no file.
--- @param bufnr integer
--- @return string|nil
local function rel_path(bufnr)
  local name = vim.api.nvim_buf_get_name(bufnr)
  if name == "" then return nil end
  return vim.fn.fnamemodify(name, ":.")
end

--- Trim a string to at most max_bytes, appending a truncation notice.
--- @param s string
--- @param max_bytes integer
--- @return string
local function trim(s, max_bytes)
  if #s <= max_bytes then return s end
  return s:sub(1, max_bytes) .. "\n... (truncated)"
end

--- Build a fenced code block for the entire buffer.
--- @param bufnr integer
--- @param opts? { max_bytes?: integer }
--- @return string|nil ctx, string|nil err
function M.buffer(bufnr, opts)
  opts = opts or {}
  local max = opts.max_bytes or 24000

  local path = rel_path(bufnr)
  if not path then return nil, "buffer has no file path" end

  local ft = vim.bo[bufnr].filetype
  local lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local content = trim(table.concat(lines, "\n"), max)

  return string.format("File: %s\n```%s\n%s\n```", path, ft, content)
end

--- Build a fenced code block for the last visual selection.
--- Must be called while the visual marks '<  '> are still set.
--- @param bufnr integer
--- @param opts? { max_bytes?: integer }
--- @return string|nil ctx, string|nil err
function M.selection(bufnr, opts)
  opts = opts or {}
  local max = opts.max_bytes or 24000

  local path = rel_path(bufnr)
  if not path then return nil, "buffer has no file path" end

  local ft = vim.bo[bufnr].filetype
  local s = vim.fn.getpos("'<")
  local e = vim.fn.getpos("'>")
  local s_line, e_line = s[2], e[2]

  local region = vim.fn.getregion(s, e, { type = vim.fn.visualmode() })
  local content = trim(table.concat(region, "\n"), max)

  return string.format(
    "File: %s (lines %d–%d)\n```%s\n%s\n```",
    path, s_line, e_line, ft, content
  )
end

--- Build a diagnostics summary for a buffer.
--- Returns nil when there are no diagnostics.
--- @param bufnr integer
--- @return string|nil
function M.diagnostics(bufnr)
  local diags = vim.diagnostic.get(bufnr)
  if #diags == 0 then return nil end

  local severity_name = { "ERROR", "WARN", "INFO", "HINT" }
  local lines = { "LSP Diagnostics:" }

  for _, d in ipairs(diags) do
    local sev = severity_name[d.severity] or "?"
    table.insert(lines, string.format("  [%s] line %d: %s", sev, d.lnum + 1, d.message))
  end

  return table.concat(lines, "\n")
end

return M
