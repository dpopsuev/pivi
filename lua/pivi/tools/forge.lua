--- pivi.tools.forge — persistent user tool repository.
---
--- Tools are stored as Lua modules under the pivi-user-tools Lazy plugin:
---   ~/.local/share/pivi/tools/lua/pivi/user/<name>.lua
---
--- Discovery: nvim_get_runtime_file("lua/pivi/user/*.lua", true) scans
--- every rtp entry, so community plugins that include lua/pivi/user/*.lua
--- contribute tools automatically — same pattern as LuaSnip's luasnippets/.
---
--- Agent inner loop for authoring a new tool (write → verify → fix → test):
---   1. pivi_forge_tool(name, description, lua)  -- write the file
---   2. nvim_open_file(path)                     -- open in Neovim
---   3. nvim_lsp_wait(path)                      -- synchronise: wait for lua_ls
---   4. nvim_get_diagnostics(path)               -- read type errors / undefined globals
---   5. nvim_buf_write(path, fixed_lua)           -- fix and repeat from 4
---   6. nvim_lua('require("pivi.user.name").run({})') -- test with real input
---   Tool is registered immediately and persists across sessions.
---
--- Module format (all user tools must follow this shape):
---
---   local M = {}
---   M.meta = {
---     description = "What the tool does",
---     parameters  = {},  -- table describing accepted params (for documentation)
---   }
---   function M.run(params)
---     -- params is a Lua table decoded from JSON
---     return vim.fn.json_encode({ result = "..." })
---   end
---   return M

local M = {}

local TOOLS_DIR = vim.fn.expand("~/.local/share/pivi/tools/lua/pivi/user")

--- Validate a tool name: lowercase letters, digits, underscores, no leading digit.
--- @param name string
--- @return boolean, string?
local function validate_name(name)
  if not name:match("^[a-z][a-z0-9_]*$") then
    return false, "tool name must be lowercase snake_case starting with a letter (got: " .. name .. ")"
  end
  if #name > 64 then
    return false, "tool name too long (max 64 chars)"
  end
  return true
end

--- Write a tool file and bust the Lua cache so it is immediately require()-able.
--- @param name string   snake_case tool name
--- @param lua  string   complete Lua module source
--- @return string  JSON: { path, name } or { error }
function M.write_tool(name, lua)
  local ok, err = validate_name(name)
  if not ok then
    return vim.fn.json_encode({ error = err })
  end

  vim.fn.mkdir(TOOLS_DIR, "p")

  local path  = TOOLS_DIR .. "/" .. name .. ".lua"
  local lines = vim.split(lua, "\n", { plain = true })
  if vim.fn.writefile(lines, path) ~= 0 then
    return vim.fn.json_encode({ error = "could not write " .. path })
  end

  -- Bust cache so the new or updated module is loaded fresh on next require()
  package.loaded["pivi.user." .. name] = nil

  return vim.fn.json_encode({ path = path, name = name })
end

--- List all available user tools across all rtp entries.
--- Returns name + description for each tool whose module loads successfully.
--- @return string  JSON: { tools: [{name, description, path}] }
function M.list_tools()
  local tools = {}
  local seen  = {}

  for _, path in ipairs(vim.api.nvim_get_runtime_file("lua/pivi/user/*.lua", true)) do
    local name = path:match("([^/]+)%.lua$")
    if name and not seen[name] then
      seen[name] = true
      local mod_ok, mod = pcall(require, "pivi.user." .. name)
      if mod_ok and type(mod) == "table" and mod.meta then
        table.insert(tools, {
          name        = name,
          description = mod.meta.description or "",
          path        = path,
        })
      end
    end
  end

  return vim.fn.json_encode({ tools = tools })
end

--- Remove a tool from the personal forge and bust its Lua cache.
--- Only removes tools in the personal forge dir — cannot delete community tools.
--- @param name string
--- @return string  JSON: { dropped } or { error }
function M.drop_tool(name)
  local ok, err = validate_name(name)
  if not ok then
    return vim.fn.json_encode({ error = err })
  end

  local path = TOOLS_DIR .. "/" .. name .. ".lua"
  if vim.fn.filereadable(path) == 0 then
    return vim.fn.json_encode({ error = "tool '" .. name .. "' not found in personal forge" })
  end

  vim.fn.delete(path)
  package.loaded["pivi.user." .. name] = nil

  return vim.fn.json_encode({ dropped = name })
end

--- Call a named user tool, decoding params from JSON and encoding result as JSON.
--- Used by extension.ts to invoke user tools via a single Lua call.
--- @param name   string  tool name
--- @param params string  JSON-encoded params table
--- @return string  raw return value from M.run() (should be JSON)
function M.call_tool(name, params)
  local mod_ok, mod = pcall(require, "pivi.user." .. name)
  if not mod_ok then
    return vim.fn.json_encode({ error = "could not load tool '" .. name .. "': " .. tostring(mod) })
  end
  if type(mod.run) ~= "function" then
    return vim.fn.json_encode({ error = "tool '" .. name .. "' has no M.run function" })
  end

  local p_ok, p = pcall(vim.fn.json_decode, params)
  if not p_ok then p = {} end

  local run_ok, result = pcall(mod.run, p)
  if not run_ok then
    return vim.fn.json_encode({ error = "tool '" .. name .. "' errored: " .. tostring(result) })
  end

  return type(result) == "string" and result or vim.fn.json_encode({ result = result })
end

return M
