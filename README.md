# pivi

Pi inside Neovim.

pivi is a [Pi](https://pi.dev/) extension + Neovim plugin that runs Pi as a background process inside the editor. Pi connects back to Neovim via msgpack-RPC and gains read/write access to every open buffer, live LSP diagnostics, cursor position, and the full Neovim API — before the user types a word.

Unlike AI editor plugins that spawn a model on demand, pivi keeps Pi alive as a persistent session. The conversation context, tool state, and forged tools accumulate across turns.

> **Pi can build pivi tools.** Ask Pi to write a new Lua tool for your project. It will author, type-check with lua_ls, test, and register it in one session — available in every future session automatically.

---

## Requirements

- Neovim >= 0.10
- [Pi](https://pi.dev/) installed and on `PATH`
- [snacks.nvim](https://github.com/folke/snacks.nvim) (UI)

Optional — each unlocks additional Pi tools:

- [stevearc/aerial.nvim](https://github.com/stevearc/aerial.nvim) — `nvim_get_symbols`
- [nvim-neotest/neotest](https://github.com/nvim-neotest/neotest) + adapter — `nvim_run_tests`
- [stevearc/overseer.nvim](https://github.com/stevearc/overseer.nvim) — `nvim_run_task`
- [mfussenegger/nvim-dap](https://github.com/mfussenegger/nvim-dap) — `nvim_set_breakpoint`, `nvim_get_variables`

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
    require("pivi").setup({
      -- Declare Pi extensions to install automatically on first launch
      extensions = {
        ensure_installed = { "npm:plan-mode", "npm:git-checkpoints" },
      },
    })
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

```
:PiviLaunch
```

This starts Pi as a background job with `$NVIM` set to Neovim's socket. Pi connects back via msgpack-RPC, detects which optional plugins are installed, and registers the corresponding tools. The winbar shows the connection state.

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

Before every agent turn, pivi injects the current editor state into Pi's context automatically — no prompt needed:

```
Neovim: src/auth.ts  line 45 col 3
  [ERROR] line 45: Type 'string' is not assignable to type 'number'
  [WARN]  line 12: 'userId' is declared but never read
```

The context refreshes between every LLM call within a turn, so Pi always acts on live state, not a snapshot from turn start.

---

## Tools

Pi only sees tools that will work in the current session. Tools for absent plugins are ablated at connection time.

### Core tools

| Tool | Description |
|---|---|
| `nvim_lua` | Execute arbitrary Lua. The general Neovim API surface. |
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

### Soft-dep tools

Registered only when the corresponding plugin is installed.

| Tool | Requires | Description |
|---|---|---|
| `nvim_get_symbols` | aerial.nvim | Symbol outline — functions, classes, methods |
| `nvim_run_tests` | neotest + adapter | Run tests, return structured pass/fail |
| `nvim_run_task` | overseer.nvim | Run build tasks (make, cargo, npm), read output |
| `nvim_set_breakpoint` | nvim-dap | Toggle a debug breakpoint |
| `nvim_get_variables` | nvim-dap + active session | Read local variables from current debug frame |

### Tool forge

Pi can author its own tools and use them in every future session.

| Tool | Description |
|---|---|
| `pivi_forge_tool` | Write a Lua tool to the repository and register it immediately |
| `pivi_list_tools` | List all tools in the repository |
| `pivi_drop_tool` | Remove a tool from the personal forge |
| `nvim_lsp_wait` | Wait for lua_ls to attach — synchronisation point in the agent inner loop |

---

## Tool forge

Pi accumulates project knowledge as Lua modules — callable in every future session, type-checked by lua_ls, version-controlled.

Tools live under a Lazy plugin:

```
~/.local/share/pivi/tools/lua/pivi/user/   ← personal forge (global)
<cwd>/.pivi/lua/pivi/user/                 ← project-local (commit to repo)
```

Any Lazy plugin with `lua/pivi/user/*.lua` contributes tools automatically — same discovery pattern as LuaSnip's `luasnippets/`.

**Module format:**

```lua
-- lua/pivi/user/find_failing_tests.lua
local M = {}

M.meta = {
  description = "Run tests and return structured pass/fail results",
  parameters  = { file = "optional: path to test file" },
}

function M.run(params)
  local obj = vim.system({ "npm", "test", "--json" }, { text = true }):wait()
  return vim.fn.json_encode({ output = obj.stdout, code = obj.code })
end

return M
```

**Agent inner loop for authoring a tool:**

```
pivi_forge_tool(name, description, lua)        write the file
nvim_open_file(path)                           open in Neovim
nvim_lsp_wait(path)                            wait for lua_ls to attach
nvim_get_diagnostics(path)                     read type errors, undefined globals
nvim_buf_write(path, fixed_lua)                fix — repeat until clean
nvim_lua('require("pivi.user.name").run({})')  test with real input
```

lua_ls (via lazydev.nvim) provides full `vim.*` type annotations automatically for all tools in the repository.

---

## Socket location

Sockets live under `$XDG_RUNTIME_DIR/pivi/` (e.g. `/run/user/1000/pivi/` on Linux, `$TMPDIR/pivi/` on macOS). Follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/): user-owned, mode 0700, cleaned on logout.

---

## License

MIT
