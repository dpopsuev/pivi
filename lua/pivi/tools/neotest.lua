--- pivi.tools.neotest — nvim_run_tests via neotest.

local M = {}

--- Run tests for a file and return structured results as a JSON string.
--- @param file string  absolute path, or '' to use the current buffer
--- @return string  JSON: { passed, failed, results } or { error }
function M.run_tests(file)
  local ok, neotest = pcall(require, "neotest")
  if not ok then
    return vim.fn.json_encode({ error = "neotest not installed" })
  end

  local target = file ~= "" and file or vim.fn.expand("%:p")
  neotest.run.run(target)

  vim.wait(30000, function()
    local pos = neotest.state.positions(target)
    if not pos then return false end
    for _, v in pos:iter() do
      if v.status == "running" then return false end
    end
    return true
  end, 200)

  local passed, failed, results = 0, 0, {}
  local pos = neotest.state.positions(target)
  if pos then
    for _, v in pos:iter() do
      if v.type == "test" then
        if v.status == "passed" then
          passed = passed + 1
        elseif v.status == "failed" then
          failed = failed + 1
          table.insert(results, { name = v.name, short = v.short or "" })
        end
      end
    end
  end

  return vim.fn.json_encode({ passed = passed, failed = failed, results = results })
end

return M
