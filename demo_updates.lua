-- ============================================================
--  VSRXVC  v1.0.54  --  DEMO OF ALL RECENT UPDATES
-- ============================================================

local sep = string.rep("-", 52)

print(sep)
print("  VSRXVC  --  Recent Updates Demo")
print(sep)

-- ── 1. Double-run guard ───────────────────────────────────
print("")
print("[1] Double-run guard")
local flag = getgenv().VSRXVC_RUNNING
if flag then
    print("    VSRXVC_RUNNING = true  (loader is active)")
    print("    If you run the loader a 2nd time it returns immediately")
    print("    -- no duplicate poll loops, no double script execution")
else
    print("    VSRXVC_RUNNING = nil  (loader not injected yet)")
end

-- ── 2. placeId reporting ─────────────────────────────────
print("")
print("[2] PlaceId reporting  ->  server resolves game name")
local placeId = tostring(game.PlaceId)
local gameName = game:GetService("MarketplaceService"):GetProductInfo(game.PlaceId).Name
print("    PlaceId  : " .. placeId)
print("    Game name: " .. tostring(gameName))
print("    Status bar shows:  '1 Client | " .. tostring(gameName) .. "'")

-- ── 3. Executor name in status bar ───────────────────────
print("")
print("[3] Executor name in Run button")
local execOk, execName = pcall(identifyexecutor)
local exec = (execOk and execName) or "Unknown"
print("    Executor: " .. exec)
print("    Run button shows:  '> " .. exec .. "'")

-- ── 4. Watchdog reconnect with dynamic port ───────────────
print("")
print("[4] Auto-reconnect watchdog (dynamic port)")
local baseUrl = getgenv().VSRXVC_IP or "not set"
local port = baseUrl:match(":(%d+)$") or "?"
print("    Current baseUrl: " .. baseUrl)
print("    Extracted port : " .. port)
print("    On 10 failed polls -> tries IPs on port " .. port .. " again")

-- ── 5. Script queue (multiple scripts don't overwrite) ───
print("")
print("[5] Script queue demo")
print("    Queuing 3 scripts in a row from VS Code won't lose any")
print("    server.ts: pendingScript is string[] with .push()")
print("    All queued scripts joined with newline and sent together")

-- ── 6. From Server button in iris_menu ───────────────────
print("")
print("[6] iris_menu  ->  'From Server' button (press F1)")
print("    GET /saved-scripts  -> list of .lua files")
print("    Click any file      -> server queues it -> runs next poll")
print("    Toggle panel by clicking 'From Server' again")

-- ── 7. WebView Console ───────────────────────────────────
print("")
print("[7] WebView Console (this output is live in VS Code)")
print("    Color coded: print=white  warn=yellow  error=red")
print("    Filter buttons: All / Output / Warn / Error / System")
print("    Timestamps on every row  --  dedup buffer merges repeated lines")

-- ── 8. Status bar game name (async lookup) ───────────────
print("")
print("[8] Status bar summary")
print("    Left item  : '1 Client | " .. tostring(gameName) .. "'")
print("    Run button : '> " .. exec .. "'")
print("    Resolves game name via games.roblox.com API (~0.5s after connect)")

print("")
print(sep)
print("  All systems nominal. VSRXVC " .. (getgenv().VSRXVC_IP or "?"))
print(sep)
