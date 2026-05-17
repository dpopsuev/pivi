--- pivi.tools.lsp — LSP synchronisation helpers for Pi.
---
--- Provides the synchronisation point in the agent inner loop:
---   write → open → [nvim_lsp_wait] → verify → fix → test
---
--- When Pi writes a new Lua file, lua_ls needs ~1-3 s to attach and index.
--- Without waiting, Pi cannot distinguish "no diagnostics = clean code"
--- from "no diagnostics = lua_ls not attached yet".

local M = {}

--- Wait until an LSP client with the given name attaches to the buffer.
--- Opens the file in a hidden buffer if it is not already loaded.
---
--- @param path       string   absolute or relative file path
--- @param timeout_ms integer  max wait in ms (default 6000)
--- @param client     string   LSP client name to wait for (default "lua_ls")
--- @return string  JSON: { ok, bufnr, client? } or { ok=false, error }
function M.wait(path, timeout_ms, client)
  timeout_ms = timeout_ms or 6000
  client     = client or "lua_ls"

  local abs = vim.fn.fnamemodify(path, ":p")

  -- Ensure buffer exists (badd loads metadata without opening a window)
  local bufnr = vim.fn.bufnr(abs)
  if bufnr == -1 then
    vim.cmd("badd " .. vim.fn.fnameescape(abs))
    bufnr = vim.fn.bufnr(abs)
  end

  if bufnr == -1 then
    return vim.fn.json_encode({ ok = false, error = "could not create buffer for " .. abs })
  end

  -- Trigger buffer load so LSP can attach (bufload reads the file into memory)
  if not vim.api.nvim_buf_is_loaded(bufnr) then
    vim.fn.bufload(bufnr)
    -- Fire BufRead autocmds so LSP attaches (lspconfig listens for this)
    vim.api.nvim_exec_autocmds("BufRead", { buffer = bufnr })
  end

  -- Poll until the target client appears
  local attached = vim.wait(timeout_ms, function()
    for _, c in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
      if c.name == client then return true end
    end
    return false
  end, 150)

  if not attached then
    return vim.fn.json_encode({
      ok    = false,
      bufnr = bufnr,
      error = client .. " did not attach within " .. timeout_ms .. "ms",
    })
  end

  -- Give the client one extra tick to send its first diagnostics batch
  vim.wait(200, function() return false end)

  local attached_client = nil
  for _, c in ipairs(vim.lsp.get_clients({ bufnr = bufnr })) do
    if c.name == client then attached_client = c.name; break end
  end

  return vim.fn.json_encode({ ok = true, bufnr = bufnr, client = attached_client })
end

return M
