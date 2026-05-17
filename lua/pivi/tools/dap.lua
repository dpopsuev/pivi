--- pivi.tools.dap — nvim_set_breakpoint and nvim_get_variables via nvim-dap.

local M = {}

--- Toggle a breakpoint at file:line (or current cursor if both are blank/zero).
--- @param file string   absolute path, or '' for current buffer
--- @param line integer  1-based line number, or 0 for cursor line
--- @return string  JSON: { breakpoints } or { error }
function M.toggle_breakpoint(file, line)
  local ok, dap = pcall(require, "dap")
  if not ok then
    return vim.fn.json_encode({ error = "nvim-dap not installed" })
  end

  if file ~= "" and line > 0 then
    vim.cmd("edit " .. vim.fn.fnameescape(file))
    vim.api.nvim_win_set_cursor(0, { line, 0 })
  end

  dap.toggle_breakpoint()

  local bps = require("dap.breakpoints").get()
  local count = 0
  for _, v in pairs(bps) do count = count + #v end

  return vim.fn.json_encode({ breakpoints = count })
end

--- Read local variables from the current DAP debug frame.
--- @return string  JSON: { variables } or { error }
function M.get_variables()
  local ok, dap = pcall(require, "dap")
  if not ok then
    return vim.fn.json_encode({ error = "nvim-dap not installed" })
  end

  local session = dap.session()
  if not session then
    return vim.fn.json_encode({ error = "No active DAP session" })
  end

  local frame = session.current_frame
  if not frame then
    return vim.fn.json_encode({ error = "No current frame" })
  end

  local vars = {}
  session:request("scopes", { frameId = frame.id }, function(_, resp)
    if not (resp and resp.scopes) then return end
    for _, scope in ipairs(resp.scopes) do
      if scope.name == "Locals" or scope.name == "Local" then
        session:request("variables", { variablesReference = scope.variablesReference },
          function(_, vr)
            for _, v in ipairs((vr or {}).variables or {}) do
              table.insert(vars, { name = v.name, type = v.type, value = v.value })
            end
          end)
      end
    end
  end)

  vim.wait(2000, function() return #vars > 0 end, 50)
  return vim.fn.json_encode({ variables = vars })
end

return M
