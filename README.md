# pivi

Pi inside Neovim.

pivi is a [Pi](https://pi.dev/) extension + Neovim plugin that runs Pi as a background process inside the editor. Pi connects back to Neovim via msgpack-RPC and gains read/write access to every open buffer, live LSP diagnostics, cursor position, and the full Neovim API — before the user types a word.

Unlike AI editor plugins that spawn a model on demand, pivi keeps Pi alive as a persistent session. The conversation context, tool state, and project knowledge accumulate across turns.

---

## Requirements

- Neovim >= 0.10
- [Pi](https://pi.dev/) installed and on `PATH`
- [snacks.nvim](https://github.com/folke/snacks.nvim) (UI)

Optional — each unlocks additional Pi tools when installed:

- [stevearc/aerial.nvim](https://github.com/stevearc/aerial.nvim)
- [nvim-neotest/neotest](https://github.com/nvim-neotest/neotest) + a language adapter
- [stevearc/overseer.nvim](https://github.com/stevearc/overseer.nvim)
- [mfussenegger/nvim-dap](https://github.com/mfussenegger/nvim-dap)

---

## Installation

### Pi side

```bash
pi install npm:pivi
```

Then `/reload` in Pi.

### Neovim side

```lua
-- lazy.nvim
{
  "dpopsuev/pivi",
  lazy = false,
  dependencies = {
    "folke/snacks.nvim",
    { "stevearc/aerial.nvim",            optional = true },
    { "nvim-treesitter/nvim-treesitter", optional = true },
    { "nvim-neotest/neotest",            optional = true },
    { "stevearc/overseer.nvim",          optional = true },
    { "mfussenegger/nvim-dap",           optional = true },
  },
  config = function()
    require("pivi").setup()
  end,
  keys = {
    { "<leader>pa", "<cmd>PiviAsk<cr>",          desc = "Pi: ask (buffer)" },
    { "<leader>ps", "<cmd>PiviAskSelection<cr>", desc = "Pi: ask (selection)", mode = "v" },
    { "<leader>pf", "<cmd>PiviFile<cr>",         desc = "Pi: send file" },
    { "<leader>pp", "<cmd>PiviSend<cr>",         desc = "Pi: send prompt" },
  },
}
```

---

## Usage

Start Pi from Neovim:

```vim
:PiviLaunch
```

This starts Pi as a background job with `$NVIM` set to Neovim's socket. Pi connects back via msgpack-RPC and detects which optional plugins are installed, enabling only the tools that will actually work.

| Command | Description |
|---|---|
| `:PiviLaunch` | Start Pi with Neovim RPC connected |
| `:PiviStop` | Stop the running Pi session |
| `:PiviStatus` | Show PID, protocol version, RPC status |
| `:PiviUpdate` | Update Pi then restart |
| `:PiviSessions` | List and switch between active Pi sessions |
| `:PiviPackages` | Browse and manage Pi extensions |
| `:PiviAsk` | Send prompt + current buffer as context |
| `:PiviAskSelection` | Send prompt + visual selection |
| `:PiviFile` | Send current file path |
| `:PiviSend` | Send a raw prompt |
| `:PiviPing` | Verify Pi is reachable |

---

## Context injection

Before every agent turn, pivi injects the current editor state into Pi's context automatically — file path, cursor position, and live LSP diagnostics. No prompt needed from the user.

```
Neovim: src/auth.ts  line 45 col 3
  [ERROR] line 45: Type 'string' is not assignable to type 'number'
  [WARN]  line 12: 'userId' is declared but never read
```

The context refreshes between every LLM call within a turn, so Pi acts on live state rather than a snapshot from turn start.

---

## Tools

Pi can read and write Neovim buffers, navigate to diagnostics, run tests, set breakpoints, and execute arbitrary Lua — as tool calls, the same way it runs bash commands. pivi registers the tools; Pi calls them.

Pi only sees tools that will work in the current session. Tools for absent plugins are not shown.

### Built-in tools

| Tool | Description |
|---|---|
| `nvim_lua` | Execute arbitrary Lua. Gives Pi full access to the Neovim API. |
| `nvim_buf_write` | Write content to any open buffer by path |
| `nvim_buf_read` | Read live buffer content (unsaved changes included) |
| `nvim_open_file` | Open a file in Neovim |
| `nvim_goto_location` | Navigate cursor to file:line:col |
| `nvim_get_diagnostics` | Get live LSP diagnostics for a buffer |
| `nvim_get_buffer` | Read a buffer's content |
| `nvim_set_lines` | Replace lines in a buffer |
| `nvim_list_buffers` | List all open buffers |
| `nvim_run_command` | Run any ex command |
| `nvim_notify` | Show a notification inside Neovim |

### Tools requiring optional plugins

| Tool | Requires | Description |
|---|---|---|
| `nvim_get_symbols` | aerial.nvim | Symbol outline — functions, classes, methods |
| `nvim_run_tests` | neotest + adapter | Run tests, return structured pass/fail |
| `nvim_run_task` | overseer.nvim | Run build tasks (make, cargo, npm), read output |
| `nvim_set_breakpoint` | nvim-dap | Toggle a debug breakpoint |
| `nvim_get_variables` | nvim-dap + active session | Read local variables from current debug frame |

---

## Persistent custom tools

Pi can write Neovim Lua tools and save them permanently — available in every future session, indexed at startup, callable by name. This lets Pi accumulate project-specific knowledge over time: a tool that finds failing tests in your codebase, one that lists all API routes, one that seeds the test database.

Each custom tool is a Lua module stored in a directory that pivi adds to Neovim's runtime path on startup:

```
~/.local/share/pivi/tools/lua/pivi/user/   ← personal tools (all projects)
<cwd>/.pivi/lua/pivi/user/                 ← project tools (commit to repo)
```

Any Neovim plugin that places files under `lua/pivi/user/` also contributes tools automatically, using the same runtime path convention as [LuaSnip](https://github.com/L3MON4D3/LuaSnip)'s snippet discovery.

### Creating a custom tool

Pi creates a custom tool by writing a Lua module and saving it. The module must define a `meta` table with a description, and a `run` function that accepts parameters and returns a JSON string.

```lua
-- lua/pivi/user/find_failing_tests.lua
local M = {}

M.meta = {
  description = "Run the test suite and return a structured list of failures",
  parameters  = {},
}

function M.run(_params)
  local result = vim.system({ "npm", "test", "--json" }, { text = true }):wait()
  return vim.fn.json_encode({ output = result.stdout, exit_code = result.code })
end

return M
```

### Pi commands for custom tools

| Tool | Description |
|---|---|
| `pivi_forge_tool` | Write a custom Lua tool to the personal directory and register it immediately |
| `pivi_list_tools` | List all available custom tools across all sources |
| `pivi_drop_tool` | Delete a custom tool from the personal directory |
| `nvim_lsp_wait` | Wait until lua_ls has attached to a file — use this after writing a new tool, before reading diagnostics |

### The agent inner loop for tool authoring

When Pi writes a new tool, it follows the standard software development inner loop — write, verify, fix, test — using Neovim's own LSP and test runner as the feedback mechanism:

```
pivi_forge_tool(name, description, lua)        write the Lua module
nvim_open_file(path)                           open it in Neovim
nvim_lsp_wait(path)                            wait for lua_ls to attach
nvim_get_diagnostics(path)                     read type errors, undefined globals
nvim_buf_write(path, fixed_lua)                fix — repeat until clean
nvim_lua('require("pivi.user.name").run({})')  test with real input
```

[lazydev.nvim](https://github.com/folke/lazydev.nvim) provides full `vim.*` type annotations and `require()` completion inside custom tools automatically, because they live in a directory on Neovim's runtime path.

---

## Socket location

Sockets live under `$XDG_RUNTIME_DIR/pivi/` (e.g. `/run/user/1000/pivi/` on Linux, `$TMPDIR/pivi/` on macOS). Follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/): user-owned, mode 0700, cleaned on logout.

---

## License

MIT
