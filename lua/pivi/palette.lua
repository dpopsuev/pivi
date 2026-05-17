--- pivi.palette — semantic span constructors.
---
--- A span is {text, highlight_group}. Components build lines from spans
--- so no file ever references a highlight group string directly — all
--- colour changes go through this module.
---
--- Usage:
---   local p = require("pivi.palette")
---   local line = { p.connected("◉"), p.none(" connected"), p.muted("  cwd") }

local function hl(group)
  return function(text)
    return { text, group }
  end
end

local M = {
  none         = hl "",
  normal       = hl "PiviNormal",
  muted        = hl "PiviMuted",
  title        = hl "PiviTitle",
  header       = hl "PiviHeader",
  error        = hl "PiviError",
  warn         = hl "PiviWarn",

  -- Speakers
  you          = hl "PiviYou",
  pi           = hl "PiviPi",

  -- Lifecycle badges
  connected    = hl "PiviConnected",
  starting     = hl "PiviStarting",
  disconnected = hl "PiviDisconnected",
  not_ready    = hl "PiviNotReady",

  -- Extension manager
  installed    = hl "PiviInstalled",
  available    = hl "PiviAvailable",
  category     = hl "PiviCategory",
}

-- Escape hatch: p["AnyGroupName"]("text") works via __index
setmetatable(M, {
  __index = function(t, k)
    local f = hl(k)
    t[k] = f
    return f
  end,
})

return M
