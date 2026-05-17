--- pivi.tools.symbols — nvim_get_symbols via aerial.nvim.

local M = {}

--- Return a formatted symbol outline for the current buffer.
--- Requires aerial.nvim. Returns nil when aerial is absent.
--- @return string|nil
function M.get()
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
  return table.concat(out, "\n")
end

return M
