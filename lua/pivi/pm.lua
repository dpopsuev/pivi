--- pivi.pm — :PiviPackages extension manager UI.
---
--- Uses snacks.win with backdrop=60 and footer_keys=true.
--- Backed by pivi.registry. Sticky cursor on re-render.

local M = {}

local _win      = nil  ---@type table|nil  snacks.win instance
local _line_map = {}   ---@type table<integer, string>  row → source
local _cursor   = nil  ---@type string|nil  source under cursor before render

--- Open or focus the package manager panel.
function M.open()
  if _win and not _win.closed then
    if _win.win and vim.api.nvim_win_is_valid(_win.win) then
      vim.api.nvim_set_current_win(_win.win)
    end
    return
  end

  local ok, Snacks = pcall(require, "snacks")
  if not ok then
    vim.notify("pivi: :PiviPackages requires snacks.nvim", vim.log.levels.ERROR)
    return
  end

  _win = Snacks.win.new({
    position    = "float",
    width       = 0.55,
    height      = 0.55,
    border      = "rounded",
    title       = " π Pi — Extensions ",
    title_pos   = "center",
    backdrop    = 60,
    footer_keys = true,
    bo          = { buftype = "nofile", filetype = "pivi-packages", modifiable = false },
    wo          = { number = false, relativenumber = false, signcolumn = "no", cursorline = true },
    keys = {
      i         = function() M._install_under_cursor() end,
      ["X"]     = function() M._remove_under_cursor()  end,
      u         = function() require("pivi.lifecycle").update() end,
      r         = function() M._refresh() end,
      q         = "close",
      ["<Esc>"] = "close",
    },
    on_win = function() M._refresh() end,
  })
end

--- Refresh the package list from registry.all().
function M._refresh()
  if not (_win and not _win.closed) then return end
  -- Record cursor pkg before re-render for sticky cursor
  if _win.win and vim.api.nvim_win_is_valid(_win.win) then
    local row = vim.api.nvim_win_get_cursor(_win.win)[1]
    _cursor = _line_map[row]
  end
  require("pivi.registry").all(function(pkgs)
    M._render(pkgs)
  end)
end

--- Render the package list into the window buffer.
--- @param pkgs table[]
function M._render(pkgs)
  if not (_win and not _win.closed and _win.buf and vim.api.nvim_buf_is_valid(_win.buf)) then
    return
  end

  local p       = require("pivi.palette")
  local lines   = {}
  local hls     = {}
  local line_map = {}

  local function add(spans, source)
    local row  = #lines
    local text = ""
    for _, span in ipairs(spans) do
      local s, g = span[1], span[2]
      if g and g ~= "" then
        table.insert(hls, { g, row, #text, #text + #s })
      end
      text = text .. s
    end
    table.insert(lines, text)
    if source then line_map[row + 1] = source end
  end

  -- Installed section
  add({ p.category("Installed") })
  local has_installed = false
  for _, pkg in ipairs(pkgs) do
    if pkg.installed then
      has_installed = true
      add({
        p.installed("✓"), p.none("  "),
        p.title(pkg.name),
        pkg.version and p.muted("  " .. pkg.version) or p.none(""),
        p.muted("  " .. (pkg.description or "")),
      }, pkg.source)
    end
  end
  if not has_installed then add({ p.muted("  (none)") }) end

  add({ p.none("") })

  -- Available section
  add({ p.category("Available") })
  local has_available = false
  for _, pkg in ipairs(pkgs) do
    if not pkg.installed then
      has_available = true
      add({
        p.available("✗"), p.none("  "),
        p.muted(pkg.name),
        p.muted("  " .. (pkg.description or "")),
      }, pkg.source)
    end
  end
  if not has_available then add({ p.muted("  (none)") }) end

  -- Write to buffer
  vim.bo[_win.buf].modifiable = true
  vim.api.nvim_buf_set_lines(_win.buf, 0, -1, false, lines)
  vim.api.nvim_buf_clear_namespace(_win.buf, 0, 0, -1)
  local ns = vim.api.nvim_create_namespace("pivi-pm")
  for _, h in ipairs(hls) do
    vim.api.nvim_buf_add_highlight(_win.buf, ns, h[1], h[2], h[3], h[4])
  end
  vim.bo[_win.buf].modifiable = false

  _line_map = line_map

  -- Restore cursor to same package after re-render (sticky cursor)
  if _cursor and _win.win and vim.api.nvim_win_is_valid(_win.win) then
    for row, src in pairs(line_map) do
      if src == _cursor then
        pcall(vim.api.nvim_win_set_cursor, _win.win, { row, 2 })
        break
      end
    end
  end
end

function M._install_under_cursor()
  if not (_win and _win.win and vim.api.nvim_win_is_valid(_win.win)) then return end
  local row = vim.api.nvim_win_get_cursor(_win.win)[1]
  local src = _line_map[row]
  if not src then
    vim.notify("pivi: no package under cursor", vim.log.levels.WARN)
    return
  end
  require("pivi.registry").install(src, function(ok)
    vim.notify(
      ok and ("pivi: installed " .. src) or ("pivi: install failed"),
      ok and vim.log.levels.INFO or vim.log.levels.ERROR
    )
    M._refresh()
  end)
end

function M._remove_under_cursor()
  if not (_win and _win.win and vim.api.nvim_win_is_valid(_win.win)) then return end
  local row = vim.api.nvim_win_get_cursor(_win.win)[1]
  local src = _line_map[row]
  if not src then
    vim.notify("pivi: no package under cursor", vim.log.levels.WARN)
    return
  end
  vim.ui.select({ "yes", "no" }, { prompt = "Remove " .. src .. "?" }, function(choice)
    if choice ~= "yes" then return end
    require("pivi.registry").remove(src, function(ok)
      vim.notify(
        ok and ("pivi: removed " .. src) or "pivi: remove failed",
        ok and vim.log.levels.INFO or vim.log.levels.ERROR
      )
      M._refresh()
    end)
  end)
end

return M
