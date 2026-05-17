--- pivi — Pi agent ↔ Neovim bridge.
--- Pi is the driver. Neovim is the surface.

local socket    = require("pivi.socket")
local context   = require("pivi.context")
local lifecycle = require("pivi.lifecycle")

local M = {}

--- @class pivi.Config
--- @field context pivi.ContextConfig
--- @field extensions pivi.ExtensionsConfig

--- @class pivi.ContextConfig
--- @field max_bytes integer
--- @field diagnostics { enabled: boolean }

--- @class pivi.ExtensionsConfig
--- @field ensure_installed string[]

M.config = {
  context = {
    max_bytes   = 24000,
    diagnostics = { enabled = true },
  },
  extensions = {
    ensure_installed = {},
  },
}

--- @param opts pivi.Config|nil
function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", M.config, opts or {})
  -- Install any missing Pi extensions declared in ensure_installed
  local desired = M.config.extensions and M.config.extensions.ensure_installed or {}
  if #desired > 0 then
    vim.schedule(function()
      require("pivi.registry").ensure(desired)
    end)
  end
end

-- ── Buffer snapshot (for detecting Pi's file changes) ──────────────────────

-- ── Spinner icon (matches the winbar animation cadence) ───────────────────

local SPINNER = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
local function spin_icon()
  return SPINNER[math.floor(vim.uv.hrtime() / (1e6 * 80)) % #SPINNER + 1]
end

-- ── Helpers ────────────────────────────────────────────────────────────────

--- Shared pre-flight guard for all prompt commands.
--- @return boolean  true = proceed, false = blocked (message shown)
local function preflight_ok()
  local pf = lifecycle.preflight()
  if not pf.ok then
    local msg = "pivi: " .. pf.message
    if pf.action then msg = msg .. "  → " .. pf.action end
    vim.notify(msg, vim.log.levels.WARN)
    return false
  end
  if pf.warn then
    vim.notify("pivi: " .. pf.warn, vim.log.levels.WARN)
  end
  return true
end

local function current_bufnr()
  local bufnr = vim.api.nvim_get_current_buf()
  if vim.api.nvim_buf_get_name(bufnr) == "" then
    vim.notify("pivi: buffer has no file path", vim.log.levels.WARN)
    return nil
  end
  return bufnr
end

local function compose(prompt, ctx)
  if ctx and ctx ~= "" then
    return prompt .. "\n\nContext:\n" .. ctx
  end
  return prompt
end

-- ── send_prompt — the main dispatch called by the input buffer ────────────

--- Send flow:
---   1. Append "You: ..." to history
---   2. Start winbar spinner + working notification
---   3. Send prompt + context to Pi via socket
---   4. On response: stop spinner, append "Pi: ✓  done" to history
---
--- @param text string  Raw prompt text (no context attached yet)
function M.send_prompt(text)
  if not preflight_ok() then return end
  local ui = require("pivi.ui")

  -- 1. Show in history immediately
  ui.append("you", text)

  -- 2. Start spinner + notification
  ui.start_spinner()
  vim.notify("working…", vim.log.levels.INFO, {
    id    = "pivi_working",
    title = "π pivi",
    opts  = function(n) n.icon = spin_icon() end,
  })

  -- 3. Build context and send
  local bufnr = vim.api.nvim_get_current_buf()
  local ctx   = context.buffer(bufnr, M.config.context)
  if M.config.context.diagnostics.enabled then
    local diags = context.diagnostics(bufnr)
    if diags then ctx = (ctx or "") .. "\n\n" .. diags end
  end

  socket.send({ type = "prompt", message = compose(text, ctx) }, function(err, resp)
    ui.stop_spinner()

    if err or (resp and not resp.ok) then
      local detail = err or (resp and resp.error) or "unknown error"
      vim.notify("✗  " .. detail, vim.log.levels.ERROR, {
        id = "pivi_working", title = "π pivi", icon = "✗", timeout = 5000,
      })
      ui.append("pi", "✗  " .. detail)
      return
    end

    -- 4. Done
    vim.notify("✓  done", vim.log.levels.INFO, {
      id = "pivi_working", title = "π pivi", icon = " ", timeout = 4000,
    })
    ui.append("pi", "✓  done")
  end)
end

-- ── Public API ─────────────────────────────────────────────────────────────

--- Send a raw prompt string to the live Pi session (no context).
--- @param message string
function M.send(message)
  if not preflight_ok() then return end
  socket.send({ type = "prompt", message = message }, function(err, resp)
    if err or (resp and not resp.ok) then
      vim.notify("pivi: " .. (err or resp.error or "error"), vim.log.levels.ERROR)
    end
  end)
end

--- Prompt Pi with the current buffer as context.
--- @param prompt string
function M.ask(prompt)
  if not preflight_ok() then return end
  local bufnr = current_bufnr()
  if not bufnr then return end
  local ctx, e = context.buffer(bufnr, M.config.context)
  if not ctx then
    vim.notify("pivi: " .. (e or "context error"), vim.log.levels.ERROR)
    return
  end
  if M.config.context.diagnostics.enabled then
    local diags = context.diagnostics(bufnr)
    if diags then ctx = ctx .. "\n\n" .. diags end
  end
  M.send(compose(prompt, ctx))
end

--- Prompt Pi with the last visual selection as context.
--- @param prompt string
function M.ask_selection(prompt)
  if not preflight_ok() then return end
  local bufnr = current_bufnr()
  if not bufnr then return end
  local ctx, e = context.selection(bufnr, M.config.context)
  if not ctx then
    vim.notify("pivi: " .. (e or "context error"), vim.log.levels.ERROR)
    return
  end
  M.send(compose(prompt, ctx))
end

--- Send the current file path to Pi (Pi reads it itself).
--- @param prompt string
function M.send_file(prompt)
  if not preflight_ok() then return end
  local path = vim.fn.expand("%:p")
  if path == "" then
    vim.notify("pivi: no file open", vim.log.levels.WARN)
    return
  end
  local rel = vim.fn.expand("%:.")
  local msg = (prompt ~= "") and (prompt .. "\n\nFile: " .. path)
               or ("Look at this file: " .. rel)
  M.send(msg)
end

--- Ping the active Pi session.
function M.ping()
  socket.send({ type = "ping" }, function(err, resp)
    if err then
      vim.notify("pivi: unreachable — " .. err, vim.log.levels.ERROR)
    elseif resp and resp.type == "pong" then
      vim.notify("pivi: Pi is alive ✓", vim.log.levels.INFO)
    else
      vim.notify("pivi: unexpected response", vim.log.levels.WARN)
    end
  end)
end

--- List running Pi sessions and switch to one.
function M.sessions()
  local list = socket.list()
  if #list == 0 then
    vim.notify("pivi: no Pi sessions found", vim.log.levels.INFO)
    return
  end
  local current = socket.find()
  local items = {}
  for _, s in ipairs(list) do
    local marker = (current == s.socket) and "●" or "○"
    local time   = ""
    if s.started_at then
      local h, mi = s.started_at:match("T(%d+):(%d+)")
      if h then time = string.format(" %s:%s", h, mi) end
    end
    table.insert(items, string.format(
      "%s %s [pid %s%s%s]",
      marker, s.cwd, s.pid, time, s.nvim and " [nvim]" or ""
    ))
  end
  vim.ui.select(items, { prompt = "Pivi sessions:" }, function(_, idx)
    if not idx then return end
    local s = list[idx]
    socket.pinned = s.socket
    vim.notify(
      string.format("pivi: switched to %s [pid %s]", s.cwd, s.pid),
      vim.log.levels.INFO
    )
  end)
end

return M
