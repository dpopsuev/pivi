# pivi

**Pi drives. Neovim renders.**

pivi bridges a live [Pi](https://pi.dev/) coding agent session with Neovim. Unlike other AI editor plugins where the editor spawns and controls the agent, pivi inverts the relationship — Pi is the persistent driver and Neovim is the surface: a viewer, UI, and API platform.

## Architecture

```
┌─────────────────────────────────────────┐
│              Pi Agent                   │
│  Persistent session, conversation ctx   │
│  Edits files, runs tools, plans tasks   │
│  Has $NVIM → can drive Neovim via RPC   │
└────────────┬──────────────┬─────────────┘
             │ Unix socket  │ msgpack-RPC
             │ (Nvim → Pi)  │ (Pi → Nvim)
             ▼              ▼
┌─────────────────────────────────────────┐
│              Neovim                     │
│  Sends context, selections, diagnostics │
│  Auto-reloads files Pi edits on disk    │
│  Is the screen for Pi's agentic loop    │
└─────────────────────────────────────────┘
```

## Installation

### Pi side

```
pi install npm:pivi
```

Or add to `~/.pi/agent/settings.json`:

```json
{ "packages": ["https://github.com/DanyPops/pivi"] }
```

Then `/reload` in Pi.

### Neovim side (lazy.nvim)

```lua
{
  "DanyPops/pivi",
  config = function()
    require("pivi").setup()
  end,
  keys = {
    { "<leader>pp", "<cmd>PiviAsk<cr>",          desc = "Pi: ask with buffer" },
    { "<leader>ps", "<cmd>PiviAskSelection<cr>", desc = "Pi: ask with selection", mode = "v" },
    { "<leader>pf", "<cmd>PiviFile<cr>",         desc = "Pi: send file" },
    { "<leader>pi", "<cmd>PiviPing<cr>",         desc = "Pi: ping" },
  },
}
```

## Usage

Start Pi in one terminal. Start Neovim in another. pivi auto-discovers the Pi session matching your cwd.

| Command | Description |
|---|---|
| `:PiviSend` | Send a raw prompt to Pi |
| `:PiviAsk` | Send prompt + current buffer as context |
| `:PiviAskSelection` | Send prompt + visual selection as context |
| `:PiviFile` | Send current file path to Pi |
| `:PiviPing` | Check Pi is reachable |
| `:PiviSessions` | List and switch between Pi sessions |

## Socket location

Sockets are stored under `$XDG_RUNTIME_DIR/pivi/` (e.g. `/run/user/1000/pivi/` on Linux). Falls back to `$TMPDIR/pivi/` on macOS, then `/tmp/pivi-<uid>/`. This follows the [XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/) for runtime IPC files — user-owned, mode 0700, cleaned on logout.

## Pi inside Neovim

When Pi starts with `$NVIM` set (via `:PiviLaunch`, which injects `vim.v.servername`), it connects back to Neovim's msgpack-RPC socket and gains full access to the editor API: read/write buffers directly, navigate to errors, show virtual text, get live LSP diagnostics. Neovim becomes the API platform for the agent.

## License

MIT
