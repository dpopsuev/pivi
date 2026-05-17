--- pivi.ui — History pane and input buffer.
---
--- Window layout managed by snacks.layout (folke/snacks.nvim).
--- Colours managed by pivi.palette + pivi.colors.
--- Winbar badge reflects Pi lifecycle state from pivi.lifecycle.

local M = {}

-- ── State ──────────────────────────────────────────────────────────────────

local _layout     = nil ---@type table|nil  snacks.layout instance
local _status     = "disconnected"
local _spin_timer = nil ---@type uv.uv_timer_t|nil
local _spin_idx   = 1

local NS = vim.api.nvim_create_namespace("pivi")

-- ── Winbar ─────────────────────────────────────────────────────────────────

local SPINNER = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }

local STATE_BADGE = {
  connected    = { icon = "◉", hl = "PiviConnected"    },
  starting     = { icon = "⏳", hl = "PiviStarting"     },
  disconnected = { icon = "○", hl = "PiviDisconnected"  },
  not_ready    = { icon = "✗", hl = "PiviNotReady"      },
}

local function make_winbar()
  local badge = STATE_BADGE[_status] or STATE_BADGE.disconnected
  local cwd   = vim.fn.fnamemodify(vim.uv.cwd() or "", ":~")
  return string.format(
    " %%#PiviTitle#π pivi%%*  %%#%s#%s%%*  %%#PiviMuted#%s%%*",
    badge.hl, badge.icon, cwd
  )
end

local function _update_winbar()
  if _layout and not _layout.closed then
    local hist = _layout.wins and _layout.wins.history
    if hist and hist.win and vim.api.nvim_win_is_valid(hist.win) then
      vim.wo[hist.win].winbar = make_winbar()
    end
  end
end

--- Update the status badge. Called by lifecycle when Pi connects/disconnects.
--- @param status "connected"|"starting"|"disconnected"|"not_ready"
function M.set_status(status)
  _status = status
  _update_winbar()
end

-- ── History ────────────────────────────────────────────────────────────────

--- Append a spoken line to the history buffer.
--- @param speaker "pi"|"you"
--- @param text string
function M.append(speaker, text)
  if not (_layout and not _layout.closed) then return end
  local hist = _layout.wins and _layout.wins.history
  if not (hist and hist.buf and vim.api.nvim_buf_is_valid(hist.buf)) then return end

  local buf    = hist.buf
  local p      = require("pivi.palette")
  local prefix = speaker == "pi" and "Pi:  " or "You: "
  local span   = speaker == "pi" and p.pi(prefix) or p.you(prefix)
  local lines  = vim.split(text, "\n", { plain = true })

  vim.bo[buf].modifiable = true

  -- Blank separator between entries
  local n    = vim.api.nvim_buf_line_count(buf)
  local last = n > 0 and vim.api.nvim_buf_get_lines(buf, -2, -1, false)[1] or ""
  if last ~= "" then
    vim.api.nvim_buf_set_lines(buf, -1, -1, false, { "" })
  end

  -- First line with coloured prefix
  local first_text = span[1] .. (lines[1] or "")
  vim.api.nvim_buf_set_lines(buf, -1, -1, false, { first_text })
  local row = vim.api.nvim_buf_line_count(buf) - 1
  vim.api.nvim_buf_set_extmark(buf, NS, row, 0, {
    end_col  = #span[1],
    hl_group = span[2],
  })

  -- Continuation lines
  for i = 2, #lines do
    vim.api.nvim_buf_set_lines(buf, -1, -1, false, { "     " .. lines[i] })
  end

  vim.bo[buf].modifiable = false

  -- Auto-scroll to bottom
  if hist.win and vim.api.nvim_win_is_valid(hist.win) then
    pcall(vim.api.nvim_win_set_cursor, hist.win, { vim.api.nvim_buf_line_count(buf), 0 })
  end
end

-- ── Spinner ────────────────────────────────────────────────────────────────

function M.start_spinner()
  if _spin_timer then return end
  _spin_idx   = 1
  _spin_timer = vim.uv.new_timer()
  _spin_timer:start(0, 80, vim.schedule_wrap(function()
    if not (_layout and not _layout.closed) then
      M.stop_spinner(); return
    end
    local hist = _layout.wins and _layout.wins.history
    if not (hist and hist.win and vim.api.nvim_win_is_valid(hist.win)) then
      M.stop_spinner(); return
    end
    local frame = SPINNER[(_spin_idx % #SPINNER) + 1]
    _spin_idx   = _spin_idx + 1
    local cwd   = vim.fn.fnamemodify(vim.uv.cwd() or "", ":~")
    vim.wo[hist.win].winbar = string.format(
      " %%#PiviTitle#π pivi%%*  %%#PiviStarting#%s%%*  %%#PiviMuted#%s%%*",
      frame, cwd
    )
  end))
end

function M.stop_spinner()
  if _spin_timer then
    _spin_timer:stop()
    _spin_timer:close()
    _spin_timer = nil
  end
  _update_winbar()
end

-- ── Layout ─────────────────────────────────────────────────────────────────

--- @return boolean
function M.is_open()
  return _layout ~= nil and not _layout.closed
end

--- Open or focus the pivi panel.
function M.open()
  -- Load colours on first open
  pcall(require, "pivi.colors")

  if M.is_open() then
    -- Focus the input window
    local inp = _layout.wins and _layout.wins.input
    if inp and inp.win and vim.api.nvim_win_is_valid(inp.win) then
      vim.api.nvim_set_current_win(inp.win)
      vim.cmd("startinsert")
    end
    return
  end

  local ok_snacks, Snacks = pcall(require, "snacks")

  if ok_snacks and Snacks.layout then
    -- ── snacks.layout path ──────────────────────────────────────────────
    _layout = Snacks.layout.new({
      wins = {
        history = Snacks.win.new({
          position = "bottom",
          height   = 18,
          enter    = false,
          bo = {
            filetype   = "markdown",
            buftype    = "nofile",
            modifiable = false,
            swapfile   = false,
          },
          wo = {
            number         = false,
            relativenumber = false,
            signcolumn     = "no",
            wrap           = true,
            linebreak      = true,
            winfixheight   = true,
            winbar         = make_winbar(),
          },
        }),
        input = Snacks.win.new({
          position    = "bottom",
          height      = 3,
          enter       = true,
          footer_keys = { "q" },
          bo = { buftype = "prompt", swapfile = false },
          wo = {
            winfixheight   = true,
            number         = false,
            relativenumber = false,
            signcolumn     = "no",
            statusline     = "%#PiviMuted#  ↵ send   q close%*",
          },
          keys = {
            q         = "close",
            ["<Esc>"] = "close",
          },
          on_buf = function(win)
            vim.fn.prompt_setprompt(win.buf, " ▸ ")
            vim.fn.prompt_setcallback(win.buf, function(text)
              text = vim.trim(text)
              if text ~= "" then require("pivi").send_prompt(text) end
            end)
            vim.fn.prompt_setinterrupt(win.buf, function()
              vim.notify("pivi: cancelling…", vim.log.levels.INFO)
            end)
          end,
        }),
      },
      layout = {
        box      = "vertical",
        position = "bottom",
        height   = 22,
        { win = "history", height = 18 },
        { win = "input",   height = 3  },
      },
    })
  else
    -- ── Fallback: raw split path (when snacks.nvim is not installed) ────
    vim.o.equalalways = false
    local hist_buf = vim.api.nvim_create_buf(false, true)
    vim.bo[hist_buf].buftype    = "nofile"
    vim.bo[hist_buf].bufhidden  = "hide"
    vim.bo[hist_buf].filetype   = "markdown"
    vim.bo[hist_buf].modifiable = false
    vim.bo[hist_buf].swapfile   = false
    pcall(vim.api.nvim_buf_set_name, hist_buf, "pivi://history")

    local inp_buf = vim.api.nvim_create_buf(false, true)
    vim.bo[inp_buf].buftype  = "prompt"
    vim.bo[inp_buf].swapfile = false
    vim.fn.prompt_setprompt(inp_buf, " ▸ ")
    vim.fn.prompt_setcallback(inp_buf, function(text)
      text = vim.trim(text)
      if text ~= "" then require("pivi").send_prompt(text) end
    end)
    vim.fn.prompt_setinterrupt(inp_buf, function()
      vim.notify("pivi: cancelling…", vim.log.levels.INFO)
    end)

    local editor_win = vim.api.nvim_get_current_win()

    vim.cmd("botright 18split")
    local hist_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(hist_win, hist_buf)
    vim.wo[hist_win].number         = false
    vim.wo[hist_win].relativenumber = false
    vim.wo[hist_win].signcolumn     = "no"
    vim.wo[hist_win].wrap           = true
    vim.wo[hist_win].winfixheight   = true
    vim.wo[hist_win].winbar         = make_winbar()

    vim.cmd("belowright 3split")
    local inp_win = vim.api.nvim_get_current_win()
    vim.api.nvim_win_set_buf(inp_win, inp_buf)
    vim.wo[inp_win].number         = false
    vim.wo[inp_win].relativenumber = false
    vim.wo[inp_win].signcolumn     = "no"
    vim.wo[inp_win].winfixheight   = true
    vim.wo[inp_win].statusline     = "%#PiviMuted#  ↵ send   q close%*"

    local ko = { buffer = inp_buf, noremap = true, silent = true }
    vim.keymap.set("n", "q", M.close, vim.tbl_extend("force", ko, { desc = "pivi: close" }))

    -- Wrap in a minimal layout-like table for compatibility
    _layout = {
      closed = false,
      wins = {
        history = { buf = hist_buf, win = hist_win },
        input   = { buf = inp_buf,  win = inp_win  },
      },
      close = function(self)
        self.closed = true
        pcall(vim.api.nvim_win_close, inp_win, true)
        pcall(vim.api.nvim_win_close, hist_win, true)
      end,
    }

    vim.api.nvim_set_current_win(editor_win)
  end
end

--- Close the pivi panel.
function M.close()
  if _layout then
    if type(_layout.close) == "function" then
      pcall(_layout.close, _layout)
    end
    _layout = nil
  end
  M.stop_spinner()
end

--- Toggle the panel open / closed.
function M.toggle()
  if M.is_open() then M.close() else M.open() end
end

--- Move cursor into the input window and enter insert mode.
function M.focus()
  if not M.is_open() then M.open(); return end
  local inp = _layout.wins and _layout.wins.input
  if inp and inp.win and vim.api.nvim_win_is_valid(inp.win) then
    vim.api.nvim_set_current_win(inp.win)
    vim.cmd("startinsert")
  end
end

return M
