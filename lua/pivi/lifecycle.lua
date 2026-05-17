--- pivi.lifecycle — Pi process lifecycle.
---
--- Four states. Pi is either connected (inside Neovim) or it isn't.
--- The only state worth being in is CONNECTED.

local socket = require("pivi.socket")

local M = {}

M.STATES = {
  NOT_READY  = 1, -- pi binary not on PATH
  NO_SESSION = 2, -- pi found, no socket for this cwd
  STARTING   = 3, -- launched, socket not yet written (~1-2 s)
  CONNECTED  = 4, -- socket found; Pi is inside Neovim
}
M.STATE_NAMES = { "NOT_READY", "NO_SESSION", "STARTING", "CONNECTED" }

local _job_id   = nil   -- set by M.launch()
local _starting = false -- set by M.launch(), cleared when socket appears

--- Synchronous state detection.
--- @return integer  one of M.STATES
function M.state()
  if vim.fn.executable("pi") == 0 then return M.STATES.NOT_READY end
  if _starting then return M.STATES.STARTING end
  if not socket.find() then return M.STATES.NO_SESSION end
  return M.STATES.CONNECTED
end

--- Pre-flight check — call before any prompt command.
--- Returns { ok, state, message?, action?, warn? }
--- ok=false → do not proceed; show message.
--- ok=true  → proceed; warn is non-fatal if present.
function M.preflight()
  local s = M.state()
  if s == M.STATES.NOT_READY then
    return { ok = false, state = s, message = "Pi not found — install from https://pi.dev" }
  end
  if s == M.STATES.NO_SESSION then
    return { ok = false, state = s, message = "No Pi session running", action = ":PiviLaunch" }
  end
  if s == M.STATES.STARTING then
    return { ok = false, state = s, message = "Pi is starting — try again in a moment" }
  end
  -- Non-fatal: protocol version drift
  local sock = socket.find()
  if sock then
    local info = socket.read_info(sock)
    if info and info.piviVersion and info.piviVersion ~= socket.PROTOCOL_VERSION then
      return { ok = true, state = s, warn = "Protocol version mismatch — run :PiviUpdate then restart Pi" }
    end
  end
  return { ok = true, state = s }
end

--- Launch Pi as a background job with $NVIM injected.
--- Polls for the socket up to 6 s then notifies the user.
function M.launch()
  if _job_id and vim.fn.jobwait({ _job_id }, 0)[1] == -1 then
    vim.notify("pivi: Pi already running (job tracked)", vim.log.levels.INFO)
    return
  end
  if socket.find() then
    vim.notify("pivi: Pi already running (socket found)", vim.log.levels.INFO)
    return
  end

  _job_id = vim.fn.jobstart({ "pi" }, {
    env = {
      NVIM = vim.v.servername, -- Pi reads this and connects back to Neovim's API
      PATH = vim.env.PATH,
    },
    on_exit = function(_, code)
      _job_id   = nil
      _starting = false
      vim.notify(
        string.format("pivi: Pi exited (code %d)", code),
        code == 0 and vim.log.levels.INFO or vim.log.levels.WARN
      )
      -- Update UI status if pane is open
      local ok, ui = pcall(require, "pivi.ui")
      if ok and ui.is_open then
        pcall(ui.set_status, "disconnected")
      end
    end,
    -- NO term = true → no terminal buffer, no PTY
  })

  _starting = true
  vim.notify("pivi: starting Pi…", vim.log.levels.INFO)

  local attempts = 0
  local timer     = vim.uv.new_timer()
  timer:start(300, 300, vim.schedule_wrap(function()
    attempts = attempts + 1
    if socket.find() then
      timer:stop()
      timer:close()
      _starting = false
      vim.notify("pivi: Pi ready ✓", vim.log.levels.INFO)
      local ok, ui = pcall(require, "pivi.ui")
      if ok and ui.is_open then pcall(ui.set_status, "connected") end
    elseif attempts >= 20 then -- 6 s
      timer:stop()
      timer:close()
      _starting = false
      vim.notify("pivi: timeout waiting for Pi socket", vim.log.levels.WARN)
    end
  end))
end

--- Stop the running Pi session.
--- Uses jobstop() when pivi launched it; falls back to .info PID SIGTERM.
function M.stop()
  if _job_id then
    vim.fn.jobstop(_job_id)
    _job_id = nil
    vim.notify("pivi: Pi stopped", vim.log.levels.INFO)
    return
  end
  local sock = socket.find()
  local info = sock and socket.read_info(sock)
  if info and info.pid then
    local ok = pcall(vim.uv.kill, info.pid, 15)
    vim.notify(
      ok and ("pivi: sent SIGTERM to Pi (pid " .. info.pid .. ")")
          or "pivi: could not signal Pi process",
      ok and vim.log.levels.INFO or vim.log.levels.ERROR
    )
  else
    vim.notify("pivi: no Pi session to stop", vim.log.levels.WARN)
  end
end

--- Show Pi status in a notification.
function M.status()
  local s    = M.state()
  local sock = socket.find()
  local info = sock and socket.read_info(sock)
  local lines = {
    "π Pi — Status",
    "State:  " .. (M.STATE_NAMES[s] or "?"),
  }
  if info then
    table.insert(lines, "PID:    " .. tostring(info.pid))
    table.insert(lines, "CWD:    " .. tostring(info.cwd))
    if info.piviVersion then
      local match = info.piviVersion == socket.PROTOCOL_VERSION
      table.insert(lines, "Proto:  v" .. info.piviVersion .. (match and " ✓" or " ✗ — run :PiviUpdate"))
    end
    table.insert(lines, "Inside: " .. (socket.is_inside_neovim() and "yes (RPC connected)" or "no"))
  end
  vim.notify(table.concat(lines, "\n"), vim.log.levels.INFO)
end

--- Run pi update asynchronously. Advises restart on success.
--- @param cb? fun(ok: boolean)
function M.update(cb)
  vim.notify("pivi: running pi update…", vim.log.levels.INFO)
  vim.system({ "pi", "update" }, { text = true }, function(obj)
    vim.schedule(function()
      if obj.code == 0 then
        vim.notify(
          "pivi: update complete — restart Pi to apply (:PiviStop then :PiviLaunch)",
          vim.log.levels.INFO
        )
      else
        vim.notify("pivi: update failed (exit " .. obj.code .. ")", vim.log.levels.ERROR)
      end
      if cb then cb(obj.code == 0) end
    end)
  end)
end

--- Install a Pi extension. Defaults to npm:pivi (the pivi package itself).
--- @param source? string
--- @param cb? fun(ok: boolean)
function M.install(source, cb)
  source = source or "npm:pivi"
  vim.notify("pivi: installing " .. source .. "…", vim.log.levels.INFO)
  vim.system({ "pi", "install", source }, {}, function(obj)
    vim.schedule(function()
      vim.notify(
        obj.code == 0 and ("pivi: installed " .. source) or ("pivi: install failed (" .. source .. ")"),
        obj.code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR
      )
      if cb then cb(obj.code == 0) end
    end)
  end)
end

return M
