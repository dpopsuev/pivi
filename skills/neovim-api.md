# Neovim API Discovery

The Neovim runtime ships 134 plain-text documentation files readable
instantly via bash — no Neovim process, no hanging.

## Get the runtime path

```
nvim_lua: return vim.fn.expand('$VIMRUNTIME')
# typically /usr/share/nvim/runtime (Linux) or /opt/homebrew/... (macOS)
```

## Bash — fastest, always available

```bash
# Look up any API function
grep -A30 "nvim_buf_get_lines" /usr/share/nvim/runtime/doc/api.txt

# Browse available topics
ls /usr/share/nvim/runtime/doc/

# Read a full topic
cat /usr/share/nvim/runtime/doc/lsp.txt | head -400
```

## Key doc files

| File            | Contents                                         |
|-----------------|--------------------------------------------------|
| api.txt         | 171 nvim_* C API functions with signatures       |
| lua.txt         | vim.api, vim.fn, vim.lsp, vim.treesitter, vim.uv |
| lsp.txt         | LSP client: get_clients, buf_request_sync, ...   |
| treesitter.txt  | Tree-sitter: get_parser, query.parse, captures   |
| diagnostic.txt  | vim.diagnostic.get/set/reset                     |
| lua-guide.txt   | Practical Lua + Neovim patterns                  |
| builtin.txt     | All Vimscript built-in functions (vim.fn.*)      |

## Discover installed plugins (live session)

```lua
-- What plugins are loaded?
return vim.inspect(package.loaded)

-- All Vimscript functions
return vim.fn.getcompletion('', 'function')

-- All nvim_buf_* functions
return vim.fn.getcompletion('nvim_buf_', 'function')

-- Explore any plugin's API
return vim.inspect(require('telescope.builtin'))
```

## Replace Pi's built-in tools via nvim_lua

| Pi tool | nvim_lua equivalent                              |
|---------|--------------------------------------------------|
| bash    | `vim.system({'cmd'}, {text=true}):wait().stdout` |
| edit    | `nvim_buf_set_text(buf, r1,c1, r2,c2, lines)`   |
| read    | `vim.fn.readfile(path)` or `nvim_buf_get_lines`  |
| write   | `vim.fn.writefile(lines, path)`                  |
| grep    | `vim.fn.systemlist('rg pattern')`                |
| find    | `vim.fn.glob('**/*.lua', false, true)`           |
| ls      | `vim.fn.readdir(path)`                           |

## NEVER do

```bash
nvim --headless -c "help topic" -c "q"
# ↑ hangs — help opens a buffer and waits for UI interaction
```
