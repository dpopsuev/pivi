--- pivi.tools.probe — detect which optional plugins are available.
--- Called once on session_start to decide which tools to expose to Pi.

local M = {}

--- @return { aerial: boolean, neotest: boolean, overseer: boolean, dap: boolean }
function M.available()
  return {
    aerial   = pcall(require, "aerial"),
    neotest  = pcall(require, "neotest"),
    overseer = pcall(require, "overseer"),
    dap      = pcall(require, "dap"),
  }
end

return M
