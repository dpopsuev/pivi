-- Guard against double-loading
if vim.g.loaded_pivi then return end
vim.g.loaded_pivi = true

local pivi = require("pivi")

-- ── Commands — prompt ──────────────────────────────────────────────────────

vim.api.nvim_create_user_command("PiviSend", function()
  vim.ui.input({ prompt = "Pi ▸ " }, function(input)
    if input and input ~= "" then pivi.send(input) end
  end)
end, { desc = "Send a prompt to Pi" })

vim.api.nvim_create_user_command("PiviAsk", function()
  vim.ui.input({ prompt = "Pi ▸ (buffer) " }, function(input)
    if input and input ~= "" then pivi.ask(input) end
  end)
end, { desc = "Ask Pi with current buffer as context" })

vim.api.nvim_create_user_command("PiviAskSelection", function()
  vim.ui.input({ prompt = "Pi ▸ (selection) " }, function(input)
    if input and input ~= "" then pivi.ask_selection(input) end
  end)
end, { range = true, desc = "Ask Pi with visual selection as context" })

vim.api.nvim_create_user_command("PiviFile", function()
  vim.ui.input({ prompt = "Pi ▸ (file) " }, function(input)
    pivi.send_file(input or "")
  end)
end, { desc = "Send current file path to Pi" })

vim.api.nvim_create_user_command("PiviPing", function()
  pivi.ping()
end, { desc = "Ping the active Pi session" })

vim.api.nvim_create_user_command("PiviSessions", function()
  pivi.sessions()
end, { desc = "List and switch Pi sessions" })

-- ── Commands — lifecycle ───────────────────────────────────────────────────

vim.api.nvim_create_user_command("PiviLaunch", function()
  require("pivi.lifecycle").launch()
end, { desc = "Start Pi as a background job with $NVIM injected" })

vim.api.nvim_create_user_command("PiviStop", function()
  require("pivi.lifecycle").stop()
end, { desc = "Stop the running Pi session" })

vim.api.nvim_create_user_command("PiviStatus", function()
  require("pivi.lifecycle").status()
end, { desc = "Show Pi session status" })

vim.api.nvim_create_user_command("PiviUpdate", function()
  require("pivi.lifecycle").update()
end, { desc = "Update Pi extensions (pi update)" })

vim.api.nvim_create_user_command("PiviInstall", function(opts)
  local source = opts.args ~= "" and opts.args or nil
  require("pivi.lifecycle").install(source)
end, { nargs = "?", desc = "Install a Pi extension (default: npm:pivi)" })

-- ── Commands — UI ──────────────────────────────────────────────────────────

vim.api.nvim_create_user_command("PiviPackages", function()
  require("pivi.pm").open()
end, { desc = "Browse and manage Pi extensions" })

-- Pi is always inside Neovim (jobstart + $NVIM injected).
-- It writes buffers directly via nvim_buf_set_lines — no disk polling needed.

-- ── Cursor push — feed Pi live cursor position via rpcnotify ───────────────
--
-- After :PiviLaunch, the Pi extension writes its RPC channel ID to the
-- .info file (liveState.rpcChannel). We read it back and set up autocmds
-- so that cursor moves and buffer switches push to Pi without polling.
--
-- Robustness: all rpcnotify calls are wrapped in pcall so a stopped Pi
-- session never crashes the editor.

local _cursor_push_group = vim.api.nvim_create_augroup("PiviCursorPush", { clear = true })

local function setup_cursor_push(channel)
  vim.api.nvim_create_autocmd({ "CursorMoved", "CursorMovedI", "BufEnter", "BufWritePost" }, {
    group    = _cursor_push_group,
    callback = function()
      local buf  = vim.api.nvim_get_current_buf()
      local name = vim.api.nvim_buf_get_name(buf)
      if name == "" then return end
      local cursor = vim.api.nvim_win_get_cursor(0)
      pcall(vim.fn.rpcnotify, channel, "pivi_cursor", {
        file = vim.fn.fnamemodify(name, ":."),
        line = cursor[1],
        col  = cursor[2] + 1,
      })
    end,
  })
end

-- Re-arm cursor push whenever Pi (re)connects: watch for .info updates
-- by polling once after PiviLaunch (lifecycle wires this via callback).
-- The public entry point for lifecycle.lua to call after a successful launch.
local M_plugin = {}
function M_plugin.arm_cursor_push()
  local socket = require("pivi.socket")
  local info   = socket.read_info(socket.find())
  if not info or not info.rpcChannel then return end
  setup_cursor_push(info.rpcChannel)
end

-- Expose on the global pivi table so lifecycle.lua can call it
local ok, pivi_mod = pcall(require, "pivi")
if ok and pivi_mod then
  pivi_mod._arm_cursor_push = M_plugin.arm_cursor_push
end
