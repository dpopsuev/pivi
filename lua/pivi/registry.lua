--- pivi.registry — Pi extension registry.
---
--- Static seed of known Pi packages enriched at runtime with `pi list`.
--- Provides the data layer for :PiviPackages and ensure_installed.

local M = {}

--- Known Pi packages with metadata.
--- Extend this list as the Pi ecosystem grows.
M.known = {
  { name = "plan-mode",       source = "npm:plan-mode",       description = "Plan before implementing",       category = "workflow"    },
  { name = "pi-mcp-adapter",  source = "npm:pi-mcp-adapter",  description = "MCP server integration",         category = "integration" },
  { name = "subagent",        source = "npm:subagent",         description = "Spawn and coordinate sub-agents", category = "agents"      },
  { name = "git-checkpoints", source = "npm:git-checkpoints",  description = "Auto-checkpoint session at each turn", category = "workflow" },
  { name = "sandbox",         source = "npm:sandbox",          description = "Isolated execution environment",  category = "security"    },
}

--- Parse `pi list` output and return a list of installed source strings.
--- Async — calls cb(installed: string[]) when done.
--- @param cb fun(installed: string[])
function M.installed(cb)
  local lines = { "" }
  vim.fn.jobstart({ "pi", "list" }, {
    stdout_buffered = true,
    on_stdout = function(_, data) vim.list_extend(lines, data) end,
    on_exit   = function()
      local installed = {}
      for _, line in ipairs(lines) do
        -- Match "  npm:plan-mode" or "  git:..." indented source lines
        local src = line:match("^%s+(npm:[%w%-%.@/]+)")
               or line:match("^%s+(git:[%S]+)")
        if src then table.insert(installed, src) end
      end
      cb(installed)
    end,
  })
end

--- Merge known packages with installed list.
--- Async — calls cb(pkgs: table[]) where each pkg has .installed field.
--- @param cb fun(pkgs: table[])
function M.all(cb)
  M.installed(function(inst)
    local inst_set = {}
    for _, s in ipairs(inst) do inst_set[s] = true end

    local result = {}

    -- Known packages first
    for _, pkg in ipairs(M.known) do
      table.insert(result, vim.tbl_extend("force", pkg, {
        installed = inst_set[pkg.source] == true,
      }))
    end

    -- Installed packages not in the known list
    for _, src in ipairs(inst) do
      local found = false
      for _, pkg in ipairs(M.known) do
        if pkg.source == src then found = true; break end
      end
      if not found then
        table.insert(result, {
          name        = src,
          source      = src,
          description = "",
          category    = "other",
          installed   = true,
        })
      end
    end

    cb(result)
  end)
end

--- Install any sources from `desired` that are not already installed.
--- @param desired string[]
function M.ensure(desired)
  M.installed(function(inst)
    local inst_set = {}
    for _, s in ipairs(inst) do inst_set[s] = true end
    for _, src in ipairs(desired) do
      if not inst_set[src] then
        vim.notify("pivi: installing " .. src .. "…", vim.log.levels.INFO)
        vim.fn.jobstart({ "pi", "install", src }, {
          on_exit = function(_, code)
            vim.notify(
              code == 0 and ("pivi: installed " .. src) or ("pivi: failed to install " .. src),
              code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR
            )
          end,
        })
      end
    end
  end)
end

--- @param source string
--- @param cb? fun(ok: boolean)
function M.install(source, cb)
  vim.fn.jobstart({ "pi", "install", source }, {
    on_exit = function(_, code)
      if cb then cb(code == 0) end
    end,
  })
end

--- @param source string
--- @param cb? fun(ok: boolean)
function M.remove(source, cb)
  vim.fn.jobstart({ "pi", "remove", source }, {
    on_exit = function(_, code)
      if cb then cb(code == 0) end
    end,
  })
end

return M
