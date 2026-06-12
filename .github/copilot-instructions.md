# VSRX Multi-Tool — AI Reference

## API
| Method | Endpoint | Use |
|--------|----------|-----|
| GET | `http://127.0.0.1:6732/status` | Check client connected |
| POST | `http://127.0.0.1:6732/execute` | Run Lua script |
| GET | `http://127.0.0.1:6732/logs` | Read console output |

## Auth Token (REQUIRED)
All `/execute` and `/logs` requests require the header `x-vsrx-token`. Without it the server returns `403 Forbidden`.

**Get token once per session:**
```powershell
$token = (python -c "import sqlite3,json; c=sqlite3.connect(r'$env:APPDATA\Code\User\globalStorage\state.vscdb'); r=c.execute(\"SELECT value FROM ItemTable WHERE key='BBD5.vsrx'\").fetchone(); print(json.loads(r[0])['vsrxAuthToken'])")
```
Or hardcode the current token (regenerates only if VS Code extension is reinstalled):
```powershell
$token = "22cb3592-62a6-4101-9fb1-9fccce97e28a"
```

## Canonical Send Command (always one chained line)
From file:
```powershell
$token = "22cb3592-62a6-4101-9fb1-9fccce97e28a"; $s = [System.IO.File]::ReadAllText("C:\path\file.lua", [System.Text.Encoding]::UTF8); $sJson = ConvertTo-Json -InputObject $s -Compress; $body = "{`"script`":$sJson}"; $utf8 = New-Object System.Text.UTF8Encoding $false; [System.IO.File]::WriteAllText("$env:TEMP\vsrx_s.json", $body, $utf8); Invoke-RestMethod -Uri "http://127.0.0.1:6732/execute" -Method POST -ContentType "application/json" -Headers @{"x-vsrx-token"=$token} -InFile "$env:TEMP\vsrx_s.json"; Start-Sleep -Seconds 3; (Invoke-RestMethod -Uri "http://127.0.0.1:6732/logs" -Method GET -Headers @{"x-vsrx-token"=$token}).message | Select-Object -Last 20
```
Inline (no file):
```powershell
$token = "22cb3592-62a6-4101-9fb1-9fccce97e28a"; $lua = "print('hi')"; $sJson = ConvertTo-Json -InputObject $lua -Compress; $body = "{`"script`":$sJson}"; $utf8 = New-Object System.Text.UTF8Encoding $false; [System.IO.File]::WriteAllText("$env:TEMP\vsrx_s.json", $body, $utf8); Invoke-RestMethod -Uri "http://127.0.0.1:6732/execute" -Method POST -ContentType "application/json" -Headers @{"x-vsrx-token"=$token} -InFile "$env:TEMP\vsrx_s.json"; Start-Sleep -Seconds 3; (Invoke-RestMethod -Uri "http://127.0.0.1:6732/logs" -Method GET -Headers @{"x-vsrx-token"=$token}).message | Select-Object -Last 10
```

## Workflow
1. Check `/status` — `clients` count must be > 0
2. Write Lua to a `.lua` file OR inline `$lua = "..."`
3. Send (one chained command above)
4. Read logs — check last N entries for errors
5. Fix → re-send → re-check until clean

## Log Prefixes
- *(no prefix)* — `print()` / `warn()` output from our script
- `[error]` — fatal, must fix
- `[warn]` — usually Roblox engine noise (see ignore list)
- `[system]` — VSRX connect/disconnect events

## Ignore (Roblox engine noise, NOT our errors)
- `value of type Color3 cannot be converted to a number` (PlayerListManager)
- `_generateSelectionImageObject`, `_cycle` stack traces (CoreGui)
- `Unhandled Promise rejection: <HttpResponse:>`
- `Failed to load ... PBR textures`
- `Remote event invocation discarded`
- `Animation failed to load` — game's own assets
- Garbled `â` instead of emoji in logs = UTF-8 display issue only, NOT an error

## Fix (our code errors)
- `[string "="]:N:` — Lua syntax error on line N
- `attempt to index nil` — object doesn't exist yet
- `is not a valid member of` — wrong API
- `VSRXVC Parse/Load/Iris UI Error:` — our script crashed

---

## Inspection Tools (send inline — paste into $lua)

### Server player count + positions
```lua
local p = game:GetService("Players"):GetPlayers()
print("Players on server: " .. #p)
for _, pl in ipairs(p) do
    local hrp = pl.Character and pl.Character:FindFirstChild("HumanoidRootPart")
    local pos = hrp and ("(%.1f,%.1f,%.1f)"):format(hrp.Position.X,hrp.Position.Y,hrp.Position.Z) or "no char"
    print(pl.Name.." ["..pl.UserId.."] "..pos)
end
```

### LocalPlayer — all children + classes
```lua
local lp = game:GetService("Players").LocalPlayer
print("== LocalPlayer children ==")
for _, v in ipairs(lp:GetChildren()) do
    print(v.ClassName.." | "..v.Name)
end
```

### LocalPlayer + Character attributes
```lua
local lp = game:GetService("Players").LocalPlayer
for k,v in pairs(lp:GetAttributes()) do print("LP: "..k.." = "..tostring(v)) end
if lp.Character then
    for k,v in pairs(lp.Character:GetAttributes()) do print("CHAR: "..k.." = "..tostring(v)) end
    local h = lp.Character:FindFirstChildOfClass("Humanoid")
    if h then print("HP:"..h.Health.."/"..h.MaxHealth.." Speed:"..h.WalkSpeed.." Jump:"..h.JumpPower) end
end
```

### Inspect any model (find + attributes + children)
```lua
local name = "PUT_NAME_HERE"
local obj = workspace:FindFirstChild(name,true)
    or game:GetService("ReplicatedStorage"):FindFirstChild(name,true)
    or game:GetService("Players").LocalPlayer:FindFirstChild(name,true)
if not obj then print("Not found: "..name) return end
print(">> "..obj:GetFullName().." ["..obj.ClassName.."]")
for k,v in pairs(obj:GetAttributes()) do print("  ATTR "..k.." = "..tostring(v)) end
for _,c in ipairs(obj:GetChildren()) do print("  "..c.ClassName.." | "..c.Name) end
```

### Find all instances of a class
```lua
local CLASS = "RemoteEvent" -- change freely
local res = {}
for _,v in ipairs(game:GetDescendants()) do
    if v:IsA(CLASS) then res[#res+1] = v:GetFullName() end
end
print("Found "..#res.." "..CLASS)
for i=1,math.min(#res,30) do print(res[i]) end
```

### Find by name pattern (partial, case-insensitive)
```lua
local PATTERN = "cash" -- partial match
for _,v in ipairs(game:GetDescendants()) do
    if v.Name:lower():find(PATTERN) then
        print(v.ClassName.." | "..v:GetFullName())
    end
end
```

### Dump ReplicatedStorage top level
```lua
for _,v in ipairs(game:GetService("ReplicatedStorage"):GetChildren()) do
    print(v.ClassName.." | "..v.Name.." ("..#v:GetChildren().." children)")
end
```

### Find all LocalScripts / ModuleScripts (PlayerGui)
```lua
for _,v in ipairs(game:GetService("Players").LocalPlayer.PlayerGui:GetDescendants()) do
    if v:IsA("LocalScript") or v:IsA("ModuleScript") then
        print(v.ClassName.." | "..v:GetFullName())
    end
end
```

### List all RemoteEvents + RemoteFunctions
```lua
for _,v in ipairs(game:GetDescendants()) do
    if v:IsA("RemoteEvent") or v:IsA("RemoteFunction") then
        print(v.ClassName.." | "..v:GetFullName())
    end
end
```

---

## Hard Rules

| Rule | Detail |
|------|--------|
| One terminal call | read+encode+POST+sleep+logs — all `;` chained |
| Always ConvertTo-Json | never manually escape multi-line Lua |
| No `@'...'@` + `;` | heredoc blocks break chaining |
| Always include token | `-Headers @{"x-vsrx-token"=$token}` on every request |
| Check logs every time | never assume success |
| Destroy old GUI first | `CoreGui:FindFirstChild("Name"):Destroy()` |
| `setclipboard` → pcall | `pcall(setclipboard, text)` |
| VirtualInputManager → pcall | `pcall(function() vim:SendMouseMoveEvent(0,1,false) end)` |
| ESP parent = CoreGui | not workspace |

## xpcall Debug Wrapper (use when logs show nothing new)
```powershell
$token = "22cb3592-62a6-4101-9fb1-9fccce97e28a"; $s = [System.IO.File]::ReadAllText("C:\path\file.lua", [System.Text.Encoding]::UTF8); $w = "local ok,e=xpcall(function()\n" + $s + "\nend,function(e) warn('[ERR] '..tostring(e)) end)"; $wJson = ConvertTo-Json -InputObject $w -Compress; $body = "{`"script`":$wJson}"; $utf8 = New-Object System.Text.UTF8Encoding $false; [System.IO.File]::WriteAllText("$env:TEMP\vsrx_s.json", $body, $utf8); Invoke-RestMethod -Uri "http://127.0.0.1:6732/execute" -Method POST -ContentType "application/json" -Headers @{"x-vsrx-token"=$token} -InFile "$env:TEMP\vsrx_s.json"; Start-Sleep 4; (Invoke-RestMethod -Uri "http://127.0.0.1:6732/logs" -Method GET -Headers @{"x-vsrx-token"=$token}).message | Select-Object -Last 15
```
**Error handler rule:** ONLY `warn('[ERR] '..tostring(e))` — never concatenate backtick-n (`n) inside the handler string (PowerShell expands it → Lua Malformed string).

## Common Code Patterns

**Fly (BodyVelocity):**
```lua
local bv = Instance.new("BodyVelocity",hrp)
bv.MaxForce=Vector3.new(9e9,9e9,9e9); bv.Velocity=Vector3.zero
local bg = Instance.new("BodyGyro",hrp)
bg.MaxTorque=Vector3.new(9e9,9e9,9e9); bg.P=9e4
```
Deprecated → use `LinearVelocity`+`AlignOrientation` (OneAttachment mode) as fallback.

**Re-apply on respawn:**
```lua
game:GetService("Players").LocalPlayer.CharacterAdded:Connect(function()
    task.wait(0.5); -- re-apply here
end)
```

**Chat (TextChatService only):**
```lua
task.spawn(function()
    local ok,e=pcall(function()
        game:GetService("TextChatService").TextChannels.RBXGeneral:SendAsync("msg")
    end)
    if not ok then warn("Chat: "..tostring(e)) end
end)
```

## Language
Luau (Roblox dialect). Client-side globals: `game`, `workspace`, `Players`, `task`, `getgenv`, `setclipboard`.

---

## Client-Side vs Server-Side — Critical Mental Model

**Everything we execute runs client-side only.** The server and other players do NOT see most changes.

| Action | Who sees it | Why |
|--------|-------------|-----|
| Clone a Part into workspace | Only YOU | Replication goes Server → Client, not Client → Server |
| Clone ParticleEmitter to HRP | Only YOU | Same — client-only instance |
| Change `Humanoid.WalkSpeed` | YOU + server replicates back | Humanoid properties ARE replicated from client for local character |
| Change `HumanoidRootPart.CFrame` | YOU (move is replicated) | Character network ownership = local player |
| Fire `RemoteEvent:FireServer(...)` | Server processes it | This is how games do server actions |
| Modify another player's character | NEVER works client-side | You don't have network ownership |
| GUI changes (ScreenGui, etc.) | Only YOU | LocalPlayer.PlayerGui is purely local |
| `setclipboard`, `loadstring` | Only YOU | Executor globals, not Roblox |

### What IS replicated (things other players can see)
- Your character's **position/CFrame** — HumanoidRootPart movement IS sent to server
- Your **WalkSpeed / JumpPower** — Humanoid properties replicate
- **Animations** playing on your character — visible to others
- **Accessories / HumanoidDescription** changes — if applied via server (need RemoteEvent)
- **Chat messages** — goes through TextChatService to server

### What is NOT replicated (client-side only)
- Any `Instance.new(...)` you parent to workspace — only you see it
- ESP boxes, highlight frames — only you (that's the point)
- Particle effects cloned to your HRP — only you
- Color/material changes on your own parts — NOT replicated (server keeps original)
- BodyVelocity/BodyGyro — affects YOUR physics locally, others see the result position after network sync

### To actually affect the server — use RemoteEvents
```lua
-- Find the remote, call FireServer with correct args
local re = game:GetService("ReplicatedStorage"):FindFirstChild("SomeEvent", true)
if re then
    re:FireServer(arg1, arg2)  -- server receives this
end
```
**Tip:** Use `getconnections()` on RemoteEvent.OnClientEvent to spy on what the server sends down.

---

## Executor API Reference (Sunc / Synapse / Universal)

These are globals injected by the executor — NOT available in normal Roblox scripts. Always `pcall` any of these if unsure whether the executor supports it.

### Environment
| Function | Description |
|----------|-------------|
| `getgenv()` | Global executor environment table — persist vars across scripts |
| `getrenv()` | Roblox global environment (`_G` equivalent) |
| `getsenv(script)` | Environment of a specific Script/LocalScript instance |
| `getmenv()` | Module script environment |
| `checkcaller()` | Returns `true` if called from executor context |
| `identifyexecutor()` | Returns executor name + version string |
| `isluau()` | Returns `true` if running Luau |

### Metatable Bypass
| Function | Description |
|----------|-------------|
| `getrawmetatable(obj)` | Gets metatable even if `__metatable` is locked |
| `setrawmetatable(obj, mt)` | Sets metatable bypassing lock |
| `isreadonly(t)` | Returns `true` if table is read-only |
| `setreadonly(t, bool)` | Make table writable (`setreadonly(mt, false)`) |
| `getnamecallmethod()` | Inside `__namecall` hook — returns method name called |

**Pattern — unlock a locked metatable:**
```lua
local mt = getrawmetatable(game)
setreadonly(mt, false)
local old_index = mt.__index
mt.__index = function(self, key)
    -- intercept any index on game
    return old_index(self, key)
end
setreadonly(mt, true)
```

### Garbage Collector
| Function | Description |
|----------|-------------|
| `getgc(includeTables?)` | Returns all GC'd Lua objects (functions, tables, userdata). Pass `true` to include tables |

**Pattern — find a hidden ModuleScript table in GC:**
```lua
for _, v in ipairs(getgc(true)) do
    if type(v) == "table" and rawget(v, "SomeKnownKey") then
        print("Found hidden module table!")
    end
end
```

### Function Hooking
| Function | Description |
|----------|-------------|
| `hookfunction(orig, hook)` | Replace `orig` with `hook`, returns original func |
| `newcclosure(func)` | Wrap Lua func in C closure (bypasses `islclosure` checks) |
| `hookmetamethod(obj, mm, hook)` | Hook a metamethod directly (e.g. `"__index"`, `"__newindex"`) |
| `restorefunction(func)` | Restore a hooked function to original |
| `islclosure(func)` | Returns `true` if Lua closure |
| `iscclosure(func)` | Returns `true` if C closure |

**Pattern — hook `__index` on game to spy on property reads:**
```lua
local mt = getrawmetatable(game)
setreadonly(mt, false)
local orig = mt.__index
mt.__index = newcclosure(function(self, key)
    print("[INDEX] "..tostring(key))
    return orig(self, key)
end)
setreadonly(mt, true)
```

### Upvalues & Constants (function internals)
| Function | Description |
|----------|-------------|
| `getupvalues(func)` | Returns table of all upvalues |
| `getupvalue(func, idx)` | Get single upvalue by index |
| `setupvalue(func, idx, val)` | Set upvalue by index |
| `getconstants(func)` | Returns table of bytecode constants |
| `getconstant(func, idx)` | Get single constant |
| `setconstant(func, idx, val)` | Set constant |
| `getprotos(func)` | Returns sub-functions (proto list) |
| `debug.getinfo(func)` | Get function debug info |

### Script / Closure Inspection
| Function | Description |
|----------|-------------|
| `getscripts()` | Returns all Script/LocalScript instances in game |
| `getloadedmodules()` | Returns all loaded ModuleScripts |
| `getcallingscript()` | Returns the Script that called current function |
| `getscriptclosure(script)` | Returns the Lua function of a script |
| `getscriptbytecode(script)` | Returns bytecode string |
| `decompile(script)` | Decompile script to readable Lua (quality varies) |

**Pattern — decompile a LocalScript to read its logic:**
```lua
local scripts = getscripts()
for _, s in ipairs(scripts) do
    if s.Name == "TargetScript" then
        local src = decompile(s)
        print(src)
        break
    end
end
```

### Signal / Connection Inspection
| Function | Description |
|----------|-------------|
| `getconnections(signal)` | Returns all connections on a RBXScriptSignal |
| `firesignal(signal, ...)` | Fire a signal with args directly |

**Pattern — disable all connections on a RemoteEvent:**
```lua
local re = game:GetService("ReplicatedStorage"):FindFirstChild("AntiCheat", true)
if re then
    for _, conn in ipairs(getconnections(re.OnClientEvent)) do
        conn:Disable()  -- or conn:Disconnect()
    end
end
```

### Instance Tricks
| Function | Description |
|----------|-------------|
| `fireclickdetector(detector, dist?)` | Fires a ClickDetector without clicking |
| `fireproximityprompt(prompt)` | Triggers a ProximityPrompt without walking up |
| `firetouchinterest(part, hrp, 0or1)` | Fake touch (0=leave, 1=enter) |
| `cloneref(instance)` | Clone an instance reference (different pointer, same object) |
| `compareinstances(a, b)` | True if both point to same instance |
| `gethiddenproperty(inst, prop)` | Read a hidden/locked property |
| `sethiddenproperty(inst, prop, val)` | Write a hidden property |

**Pattern — trigger a ProximityPrompt from anywhere:**
```lua
local prompt = workspace:FindFirstChild("SomePrompt", true)
if prompt and prompt:IsA("ProximityPrompt") then
    fireproximityprompt(prompt)
end
```

### File System (executor sandbox)
| Function | Description |
|----------|-------------|
| `readfile(path)` | Read file from executor workspace folder |
| `writefile(path, content)` | Write file |
| `appendfile(path, content)` | Append to file |
| `listfiles(path)` | List files in folder |
| `isfile(path)` | Check if file exists |
| `isfolder(path)` | Check if folder exists |
| `makefolder(path)` | Create folder |
| `delfile(path)` | Delete file |

### HTTP (executor)
```lua
local res = request({
    Url = "https://example.com/api",
    Method = "GET",
    Headers = { ["Content-Type"] = "application/json" },
    Body = '{"key":"value"}'  -- for POST
})
print(res.StatusCode, res.Body)
```

### Misc
| Function | Description |
|----------|-------------|
| `setfpscap(n)` | Set FPS cap (e.g. 0 = unlimited) |
| `getfpscap()` | Get current FPS cap |
| `loadstring(str)` | Compile + execute Lua string at runtime |
| `setclipboard(str)` | Copy to clipboard — always pcall |
| `getrendersteppedlist()` | All RenderStepped connections |
| `getsynasset(id)` | Get executor asset by ID (Synapse-specific) |
