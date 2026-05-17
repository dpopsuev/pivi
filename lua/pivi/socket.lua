--- pivi.socket — Unix socket client for communicating with a live Pi session.
--- Mirrors the discovery logic on the extension.ts side.

local M = {}

--- Set by M.sessions() (via init.lua) when the user explicitly picks a session.
--- Cleared automatically when the pinned socket file disappears.
--- nil means: use the automatic cwd + version matching logic in M.find().
M.pinned = nil

--- Increment when the wire format changes incompatibly.
--- extension.ts declares the same value; a mismatch triggers a warning so
--- version skew surfaces loudly rather than causing silent decode failures.
M.PROTOCOL_VERSION = "1"

-- $XDG_RUNTIME_DIR is the canonical location for Unix sockets per the XDG
-- Base Directory Specification: mode 0700, user-owned, cleaned on logout.
-- https://specifications.freedesktop.org/basedir-spec/latest/
local function sockets_dir()
  local base = vim.env.XDG_RUNTIME_DIR
    or vim.env.TMPDIR
    or ("/tmp/pivi-" .. tostring(vim.uv.getuid()))
  return base .. "/pivi"
end

local SOCKETS_DIR = sockets_dir()

--- Find the best live Pi socket.
---
--- Priority order:
---   1. cwd-match + version-match  (newest mtime)
---   2. cwd-match + any version    (newest mtime, emits WARN if version differs)
---   3. any session + version-match (newest mtime)
---   4. any session               (newest mtime, emits WARN if version differs)
---   5. latest symlink fallback
---
--- @return string|nil
function M.find()
  -- Pinned override: user explicitly selected this session via :PiviSessions.
  if M.pinned then
    if vim.uv.fs_stat(M.pinned) then
      return M.pinned
    end
    -- Socket is gone (Pi process exited); clear the stale pin and fall through.
    M.pinned = nil
  end

  local cwd = vim.uv.cwd()
  local ok, files = pcall(vim.fn.glob, SOCKETS_DIR .. "/*.info", false, true)

  -- Buckets: [cwd+ver, cwd_any, any_ver, any_any] → {sock, mtime, version}
  local buckets = { nil, nil, nil, nil }

  local function better(slot, sock, mtime, ver)
    if not buckets[slot] or mtime > buckets[slot].mtime then
      buckets[slot] = { sock = sock, mtime = mtime, version = ver }
    end
  end

  if ok and files then
    for _, info_path in ipairs(files) do
      local sock = info_path:sub(1, -6) -- strip ".info"
      local stat = vim.uv.fs_stat(sock)
      if stat then
        local read_ok, content = pcall(vim.fn.readfile, info_path)
        if read_ok and content and content[1] then
          local parse_ok, info = pcall(vim.json.decode, content[1])
          if parse_ok and info then
            local mtime    = stat.mtime.sec
            local ver      = info.piviVersion
            local ver_ok   = ver == M.PROTOCOL_VERSION
            local is_cwd   = info.cwd == cwd

            if is_cwd and ver_ok then better(1, sock, mtime, ver)
            elseif is_cwd       then better(2, sock, mtime, ver)
            elseif ver_ok       then better(3, sock, mtime, ver)
            else                     better(4, sock, mtime, ver)
            end
          end
        end
      end
    end
  end

  -- Pick the highest-priority non-nil bucket
  for _, b in ipairs(buckets) do
    if b then
      -- Warn when the chosen session runs a different protocol version
      if b.version and b.version ~= M.PROTOCOL_VERSION then
        vim.notify(
          string.format(
            "pivi: protocol version mismatch — plugin expects %s, session has %s. " ..
            "Update pivi.nvim or restart Pi with the matching extension.",
            M.PROTOCOL_VERSION, tostring(b.version)
          ),
          vim.log.levels.WARN
        )
      end
      return b.sock
    end
  end

  -- Final fallback: latest symlink
  local base = vim.env.XDG_RUNTIME_DIR or vim.env.TMPDIR or ("/tmp/pivi-" .. tostring(vim.uv.getuid()))
  local latest = base .. "/pivi-latest.sock"
  if vim.uv.fs_stat(latest) then return latest end

  return nil
end

--- Read and decode the .info metadata for a socket path.
--- @param sock_path string
--- @return table|nil
function M.read_info(sock_path)
  local ok, content = pcall(vim.fn.readfile, sock_path .. ".info")
  if not ok or not content or not content[1] then return nil end
  local parse_ok, info = pcall(vim.json.decode, content[1])
  return parse_ok and info or nil
end

--- Validate a decoded response table against the wire protocol.
--- Returns an error string on schema violation, nil when the response is valid.
--- @param resp table
--- @return string|nil
function M._validate_response(resp)
  if type(resp.ok) ~= "boolean" then
    return string.format(
      "invalid response schema: 'ok' must be boolean, got %s",
      type(resp.ok)
    )
  end
  if resp.error ~= nil and type(resp.error) ~= "string" then
    return string.format(
      "invalid response schema: 'error' must be string or nil, got %s",
      type(resp.error)
    )
  end
  if resp.type ~= nil and type(resp.type) ~= "string" then
    return string.format(
      "invalid response schema: 'type' must be string or nil, got %s",
      type(resp.type)
    )
  end
  if resp.piviVersion ~= nil and type(resp.piviVersion) ~= "string" then
    return string.format(
      "invalid response schema: 'piviVersion' must be string or nil, got %s",
      type(resp.piviVersion)
    )
  end
  return nil
end

--- Send a JSON message to Pi and invoke cb(err, response).
--- @param msg table
--- @param cb fun(err: string|nil, resp: table|nil)|nil
function M.send(msg, cb)
  local sock_path = M.find()
  if not sock_path then
    local err = "no pivi session found — is pi running with the pivi extension?"
    vim.notify("pivi: " .. err, vim.log.levels.ERROR)
    if cb then cb(err, nil) end
    return
  end

  local pipe = vim.uv.new_pipe(false)
  if not pipe then
    if cb then cb("failed to create pipe", nil) end
    return
  end

  pipe:connect(sock_path, function(conn_err)
    if conn_err then
      vim.schedule(function()
        vim.notify("pivi: connect failed — " .. conn_err, vim.log.levels.ERROR)
        if cb then cb(conn_err, nil) end
      end)
      return
    end

    pipe:write(vim.json.encode(msg) .. "\n")

    local buf = ""
    pipe:read_start(function(read_err, data)
      if read_err then
        pipe:close()
        vim.schedule(function()
          if cb then cb(read_err, nil) end
        end)
        return
      end

      if data then
        buf = buf .. data
        local nl = buf:find("\n")
        if nl then
          local line = buf:sub(1, nl - 1)
          pipe:read_stop()
          pipe:close()
          vim.schedule(function()
            local ok, resp = pcall(vim.json.decode, line)
            if ok and resp then
              local schema_err = M._validate_response(resp)
              if schema_err then
                if cb then cb(schema_err, nil) end
              else
                if cb then cb(nil, resp) end
              end
            else
              if cb then cb("invalid JSON from pivi socket", nil) end
            end
          end)
        end
      else
        pipe:close()
      end
    end)
  end)
end

--- Return all live Pi sessions sorted newest-first.
--- @return table[]
function M.list()
  local ok, files = pcall(vim.fn.glob, SOCKETS_DIR .. "/*.info", false, true)
  if not ok or not files then return {} end

  local sessions = {}
  for _, info_path in ipairs(files) do
    local sock = info_path:sub(1, -6)
    local stat = vim.uv.fs_stat(sock)
    if stat then
      local info = M.read_info(sock)
      if info then
        table.insert(sessions, {
          socket     = sock,
          cwd        = info.cwd or "?",
          pid        = info.pid or "?",
          nvim       = info.nvim,       -- $NVIM socket (nil if not in Neovim terminal)
          started_at = info.startedAt,
          mtime      = stat.mtime.sec,
        })
      end
    end
  end

  table.sort(sessions, function(a, b) return a.mtime > b.mtime end)
  return sessions
end

--- Returns true when Pi is running inside Neovim (Neovim RPC is connected).
--- Checks the `nvimRpc` flag written to .info by extension.ts.
---
--- @return boolean
function M.is_inside_neovim()
  local sock = M.find()
  if not sock then return false end
  local info = M.read_info(sock)
  if not info then return false end
  if info.nvimRpc == true then return true end
  return info.nvim ~= nil and info.nvim ~= vim.NIL
end

--- Alias kept for callers that have not yet been updated.
M.nvim_connected = M.is_inside_neovim

return M
