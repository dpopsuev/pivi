--- pivi.colors — all Pivi* highlight groups defined in one place.
---
--- Lush-first: when the user has Lush installed (it's in their setup),
--- sym() derives colours from the active colourscheme so badges adapt
--- automatically. Falls back to raw nvim_set_hl with default=true so
--- the user can always override in their own config.

local M = {}

local function apply_raw()
  local groups = {
    -- Structure — pure links, follow the active theme
    PiviNormal       = { link = "NormalFloat",   default = true },
    PiviTitle        = { link = "Title",          default = true },
    PiviMuted        = { link = "Comment",        default = true },
    PiviHeader       = { link = "CursorLine",     bold = true, default = true },
    PiviError        = { link = "ErrorMsg",       default = true },
    PiviWarn         = { link = "WarningMsg",     default = true },
    PiviBackdrop     = { bg = "#000000",          default = true },

    -- Speakers in history
    PiviYou          = { link = "DiagnosticInfo", bold = true, default = true },
    PiviPi           = { link = "DiagnosticOk",   bold = true, default = true },

    -- Lifecycle state badges (coloured background blocks)
    PiviConnected    = { fg = "#1e222a", bg = "#98c379", bold = true, default = true },
    PiviStarting     = { fg = "#1e222a", bg = "#c678dd", bold = true, default = true },
    PiviDisconnected = { link = "Comment",        default = true },
    PiviNotReady     = { link = "ErrorMsg",       default = true },

    -- Extension manager
    PiviInstalled    = { link = "DiagnosticOk",  default = true },
    PiviAvailable    = { link = "Comment",        default = true },
    PiviCategory     = { link = "Title",    bold = true, default = true },
  }
  for name, hl in pairs(groups) do
    vim.api.nvim_set_hl(0, name, hl)
  end
end

function M.setup()
  local ok, lush = pcall(require, "lush")
  if ok then
    -- Lush path: derive from active colourscheme via sym()
    local ok2, err = pcall(function()
      lush(function(injected_fn)
        local sym = injected_fn.sym
        ---@diagnostic disable: undefined-global
        return {
          PiviNormal       { link = sym("NormalFloat") },
          PiviTitle        { link = sym("Title") },
          PiviMuted        { fg = sym("Comment").fg },
          PiviHeader       { link = sym("CursorLine"), bold = true },
          PiviError        { link = sym("ErrorMsg") },
          PiviWarn         { link = sym("WarningMsg") },
          PiviBackdrop     { bg = sym("Normal").bg.da(70) },

          PiviYou          { fg = sym("DiagnosticInfo").fg, bold = true },
          PiviPi           { fg = sym("DiagnosticOk").fg, bold = true },

          PiviConnected    { fg = sym("Normal").bg, bg = sym("DiagnosticOk").fg, bold = true },
          PiviStarting     { fg = sym("Normal").bg, bg = sym("Function").fg, bold = true },
          PiviDisconnected { fg = sym("Comment").fg },
          PiviNotReady     { link = sym("ErrorMsg") },

          PiviInstalled    { fg = sym("DiagnosticOk").fg },
          PiviAvailable    { fg = sym("Comment").fg },
          PiviCategory     { link = sym("Title"), bold = true },
        }
        ---@diagnostic enable: undefined-global
      end)
    end)
    if not ok2 then
      -- Lush spec failed (e.g. colourscheme doesn't define expected groups)
      vim.notify("pivi: Lush colour derivation failed, using fallback (" .. tostring(err) .. ")", vim.log.levels.DEBUG)
      apply_raw()
    end
  else
    apply_raw()
  end
end

-- Re-apply whenever the user changes colourscheme
vim.api.nvim_create_autocmd("ColorScheme", {
  group = vim.api.nvim_create_augroup("PiviColors", { clear = true }),
  callback = M.setup,
})

M.setup()
return M
