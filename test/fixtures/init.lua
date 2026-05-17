-- Minimal Neovim init for pivi E2E tests.
-- Loaded via `nvim --headless -u test/fixtures/init.lua`.
--
-- Requirements:
--   - PIVI_ROOT env var points to ~/Projects/pivi
--   - Adds pivi to the runtimepath so `require("pivi.*")` resolves
--   - Loads plugin/pivi.lua to register commands + autoread timer
--   - No full plugin manager, no colorscheme, no user config

local pivi_root = vim.env.PIVI_ROOT
if not pivi_root or pivi_root == "" then
  error("PIVI_ROOT env var not set — cannot load pivi for tests")
end

-- Put pivi on the runtimepath so lua/pivi/*.lua is findable
vim.opt.rtp:prepend(pivi_root)

-- Source the plugin entry point (registers commands, autoread timer, etc.)
local plugin = pivi_root .. "/plugin/pivi.lua"
if vim.fn.filereadable(plugin) == 1 then
  vim.cmd("source " .. vim.fn.fnameescape(plugin))
end

-- Call setup with defaults
require("pivi").setup()
