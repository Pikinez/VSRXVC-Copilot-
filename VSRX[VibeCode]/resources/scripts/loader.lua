---@diagnostic disable: undefined-global
-- double-run guard
if getgenv().VSRXVC_RUNNING then return end
getgenv().VSRXVC_RUNNING = true

local HttpService = game:GetService("HttpService")
local LogService = game:GetService("LogService")
local player = game.Players.LocalPlayer
local playerName = (player and player.Name) or "Server"
local playerUserId = (player and player.UserId) or 0
local placeId = tostring(game.PlaceId)
local baseUrl = getgenv().VSRXVC_IP
local baseExecName = tostring((pcall(identifyexecutor) and identifyexecutor()) or "Run")

local function detectExecutorMode()
    local ok, result = pcall(function()
        if type(getmetatable) ~= "function" then
            return false
        end
        return getmetatable(game) ~= nil
    end)

    if ok and result then
        return "internal"
    end
    return "external"
end

local executorMode = detectExecutorMode()
local execName = baseExecName .. " [" .. executorMode .. "]"

local function sendLog(msg, msgType)
    task.spawn(function()
        pcall(function()
            local payload = HttpService:JSONEncode({
                message = tostring(msg),
                type = tonumber(msgType),
                player = playerName
            })
            local token = getgenv().VSRXVC_TOKEN or ""
            local req = (getgenv().request or getgenv().http_request or (syn and syn.request))
            if req then
                req({
                    Url = baseUrl .. "/log",
                    Method = "POST",
                    Headers = { ["Content-Type"] = "application/json", ["X-VSRX-Token"] = token },
                    Body = payload
                })
            else
                HttpService:PostAsync(baseUrl .. "/log", payload, Enum.HttpContentType.ApplicationJson, false, { ["X-VSRX-Token"] = token })
            end
        end)
    end)
end

local function hookConsole()
    if getgenv().VSRXVC_CONSOLE_HOOKED then return end
    getgenv().VSRXVC_CONSOLE_HOOKED = true
    
    task.spawn(function()
        pcall(function()
            local history = LogService:GetLogHistory()
            for i = math.max(1, #history - 15), #history do
                local log = history[i]
                sendLog(log.message .. " (History)", log.messageType.Value)
            end
        end)
    end)

    LogService.MessageOut:Connect(function(msg, msgType)
        sendLog(msg, msgType.Value)
    end)
    
    sendLog("VSRXVC Console Hooked (" .. execName .. ")", 1)
    sendLog("VSRXVC Soft Type: " .. executorMode, 1)
end

-- poll loop with auto-reconnect watchdog
local RECONNECT_INTERVAL = 5
local failCount = 0
local MAX_FAILS = 10  -- after 1s of 0.1s polls = ~10 fails before trying reconnect

while true do
    task.wait(0.1)
    local ok, responseBody = pcall(function()
        local name = HttpService:UrlEncode(playerName)
        local userId = tostring(playerUserId)
        local encodedExec = HttpService:UrlEncode(execName)
        return game:HttpGet(baseUrl .. "/fetch?name=" .. name .. "&userId=" .. userId .. "&exec=" .. encodedExec .. "&placeId=" .. placeId)
    end)

    if ok and responseBody and #responseBody > 0 then
        failCount = 0
        local decodeOk, data = pcall(HttpService.JSONDecode, HttpService, responseBody)
        if decodeOk and data then
            -- store auth token received from server
            if data.token and data.token ~= "" then
                getgenv().VSRXVC_TOKEN = data.token
            end
            local script = data.script
            local config = data.config or {}
            if config.enableConsole then hookConsole() end
            if script and #script > 0 then
                local func, err = loadstring(script)
                if func then task.spawn(func)
                else warn("VSRXVC Load Error: " .. tostring(err)) end
            end
            if config.enableInternalUI then
                task.spawn(function()
                    if getgenv().VSRXVC_UI_LOADED or getgenv().VSRXVC_LOADING_UI then return end
                    getgenv().VSRXVC_LOADING_UI = true
                    if not getgenv().Iris then
                        local s1, irisSource = pcall(function() return game:HttpGet("https://raw.githubusercontent.com/x0581/Iris-Exploit-Bundle/main/bundle.lua") end)
                        if s1 and irisSource then
                            local factory, err = loadstring(irisSource)
                            if factory then
                                getgenv().Iris = factory()
                                getgenv().Iris.Init(game:GetService("CoreGui"))
                            end
                        end
                    end
                    if getgenv().Iris then
                        local s2, menuScript = pcall(function() return game:HttpGet(baseUrl .. "/iris-menu") end)
                        if s2 and menuScript then
                            local func, err = loadstring(menuScript)
                            if func then
                                func()
                                getgenv().VSRXVC_UI_LOADED = true
                                if config.showUIOnLoad then
                                    getgenv().VSRXVC_States.Opened:set(true)
                                end
                            end
                        end
                    end
                    getgenv().VSRXVC_LOADING_UI = false
                end)
            end
        end
    else
        failCount = failCount + 1
        if failCount >= MAX_FAILS then
            failCount = 0
            warn("VSRXVC: Connection lost. Attempting reconnect in " .. RECONNECT_INTERVAL .. "s...")
            task.wait(RECONNECT_INTERVAL)
            -- extract port from current baseUrl dynamically
            local port = baseUrl:match(":(%d+)$") or "6732"
            local ips = { "http://127.0.0.1:" .. port, "http://10.0.2.2:" .. port }
            for _, ip in ipairs(ips) do
                local s, r = pcall(function() return game:HttpGet(ip .. "/") end)
                if s and r and r:find("VSRX") then
                    baseUrl = ip
                    getgenv().VSRXVC_IP = ip
                    warn("VSRXVC: Reconnected to " .. ip)
                    break
                end
            end
        end
    end
end
