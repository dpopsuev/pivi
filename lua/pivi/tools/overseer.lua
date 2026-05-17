--- pivi.tools.overseer — nvim_run_task via overseer.nvim.

local M = {}

--- List available task templates or run a named task.
--- @param name string  task template name, or '' to list available templates
--- @return string  JSON: { available } or { status, output } or { error }
function M.run_task(name)
  local ok, overseer = pcall(require, "overseer")
  if not ok then
    return vim.fn.json_encode({ error = "overseer not installed" })
  end

  if name == "" then
    local templates = overseer.list_task_templates({})
    return vim.fn.json_encode({
      available = vim.tbl_map(function(t) return t.name end, templates),
    })
  end

  local task = overseer.run_template({ name = name })
  if not task then
    return vim.fn.json_encode({ error = "Template not found: " .. name })
  end

  local done = false
  task:subscribe("on_complete", function() done = true end)
  vim.wait(60000, function() return done end, 200)

  local lines = {}
  local bufnr = task:get_bufnr()
  if bufnr and vim.api.nvim_buf_is_valid(bufnr) then
    lines = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  end

  return vim.fn.json_encode({
    status = task.status,
    output = table.concat(lines, "\n"),
  })
end

return M
