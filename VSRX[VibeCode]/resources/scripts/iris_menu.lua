--[[
    VSRXVC - Advanced Game Debugging & Exploitation Framework
    Real-time monitoring, code execution, memory inspection, object manipulation
]]

---@diagnostic disable: undefined-global
local GENV = (type(getgenv) == "function" and getgenv()) or _G
GENV._VSRXVC_MENU_RUN_ID = (GENV._VSRXVC_MENU_RUN_ID or 0) + 1
local MENU_RUN_ID = GENV._VSRXVC_MENU_RUN_ID

-- Force-close previous menu state to avoid stale callbacks
if GENV.VSRXVC_States and GENV.VSRXVC_States.Opened then
    pcall(function()
        GENV.VSRXVC_States.Opened:set(false)
    end)
end

local baseUrl = GENV.VSRXVC_IP or "http://127.0.0.1:6732"
local Iris = GENV.Iris

-- Auto-bootstrap Iris for standalone testing
if not Iris then
    local okSource, irisSource = pcall(function()
        return game:HttpGet("https://raw.githubusercontent.com/x0581/Iris-Exploit-Bundle/main/bundle.lua")
    end)

    if okSource and irisSource and type(loadstring) == "function" then
        local factory = loadstring(irisSource)
        if factory then
            local okFactory, builtIris = pcall(factory)
            if okFactory and builtIris then
                Iris = builtIris
                GENV.Iris = builtIris
                pcall(function()
                    builtIris.Init(game:GetService("CoreGui"))
                end)
            end
        end
    end
end

local IS_STANDALONE = not GENV.VSRXVC_IP

if not Iris then
    warn("VSRXVC: Iris library not found. Download and set getgenv().Iris = IrisLibrary")
    return
end

-- Cleanup helper
local function tryDisconnectConnections(container, depth, visited)
    if type(container) ~= "table" or depth <= 0 then return end
    visited = visited or {}
    if visited[container] then return end
    visited[container] = true

    for _, value in pairs(container) do
        if typeof(value) == "RBXScriptConnection" then
            pcall(function() value:Disconnect() end)
        elseif type(value) == "table" then
            tryDisconnectConnections(value, depth - 1, visited)
        end
    end
end

-- Clean up stale Iris state
pcall(function()
    if type(Iris.Shutdown) == "function" then Iris.Shutdown() end
    if type(Iris.Disconnect) == "function" then Iris.Disconnect() end
    if type(Iris.Reset) == "function" then Iris.Reset() end
    if type(Iris.Internal) == "table" then tryDisconnectConnections(Iris.Internal, 4) end
end)

local HttpService = game:GetService("HttpService")
local UserInputService = game:GetService("UserInputService")

-- Modern Dark Color Scheme
local COLORS = {
    BgPrimary    = Color3.fromRGB(20, 20, 25),
    BgSecondary  = Color3.fromRGB(30, 30, 38),
    BgTertiary   = Color3.fromRGB(40, 40, 50),
    BgHover      = Color3.fromRGB(50, 50, 65),
    
    AccentBlue   = Color3.fromRGB(100, 180, 255),
    AccentCyan   = Color3.fromRGB(80, 220, 220),
    AccentGreen  = Color3.fromRGB(110, 230, 140),
    AccentRed    = Color3.fromRGB(255, 100, 100),
    
    TextMain     = Color3.fromRGB(230, 230, 235),
    TextSub      = Color3.fromRGB(170, 170, 180),
    TextDim      = Color3.fromRGB(120, 120, 130),
    
    Border       = Color3.fromRGB(60, 60, 75),
}

-- Apply global theme
if not GENV.VSRXVC_ThemeApplied then
    GENV.VSRXVC_ThemeApplied = true
    pcall(function()
        Iris.UpdateGlobalConfig({
            WindowBgTransparency = 0.02,
            TitleBgTransparency = 0,
            FrameBgTransparency = 0,
            ButtonTransparency = 0,
            TextTransparency = 0,
            SeparatorTransparency = 0.2,
            ScrollbarSize = 5,
            ItemSpacing = Vector2.new(4, 4),
        })
    end)
end

-- Initialize state
if not GENV.VSRXVC_States then
    GENV.VSRXVC_States = {
        -- Core UI
        Opened = Iris.State(false),
        ActiveTab = Iris.State("console"),
        
        -- Console
        ConsoleLogs = Iris.State({}),
        ConsoleFilter = Iris.State("all"),
        AutoScroll = Iris.State(true),
        
        -- Code Editor
        Code = Iris.State("local p = game:GetService('Players').LocalPlayer\nprint('Hello from VSRXVC!')"),
        EditorFontSize = Iris.State(12),
        ExecutionHistory = Iris.State({}),
        Favorites = Iris.State({}),
        
        -- Search
        SearchQuery = Iris.State(""),
        SearchResults = Iris.State({}),
        SearchMode = Iris.State("all"),
        
        -- Objects
        InspectedObject = Iris.State(nil),
        ObjectsList = Iris.State({}),
        SelectedIndex = Iris.State(1),
        
        -- Player Tweaks
        TweakWalkSpeed = Iris.State(16),
        TweakJumpPower = Iris.State(50),
        TweakGravity = Iris.State(196.2),
        FlyEnabled = Iris.State(false),
        
        -- Settings
        AutoFetchServer = Iris.State(true),
        MaxResults = Iris.State(100),
        
        -- Capabilities
        HasMetatable = Iris.State(false),
        HasHookfunction = Iris.State(false),
    }
end

local States = GENV.VSRXVC_States

-- Check executor capabilities
local function checkCapabilities()
    local hasMetatable = pcall(function() getrawmetatable(game) end)
    local hasHookfunction = pcall(function() hookfunction(function() end, function() end) end)
    States.HasMetatable:set(hasMetatable)
    States.HasHookfunction:set(hasHookfunction)
end

checkCapabilities()

-- Initialize console logs
local initialLogs = States.ConsoleLogs:get()
if #initialLogs == 0 then
    table.insert(initialLogs, { level = "info", text = "=== VSRXVC Initialized ===", time = os.date("%H:%M:%S") })
    table.insert(initialLogs, { level = "success", text = "Iris library loaded", time = os.date("%H:%M:%S") })
    if IS_STANDALONE then
        table.insert(initialLogs, { level = "warn", text = "STANDALONE MODE (no VSRX extension)", time = os.date("%H:%M:%S") })
    else
        table.insert(initialLogs, { level = "success", text = "Connected to VSRX bridge", time = os.date("%H:%M:%S") })
    end
    table.insert(initialLogs, { level = "info", text = "getrawmetatable: " .. (States.HasMetatable:get() and "OK" or "MISSING"), time = os.date("%H:%M:%S") })
    table.insert(initialLogs, { level = "info", text = "hookfunction: " .. (States.HasHookfunction:get() and "OK" or "MISSING"), time = os.date("%H:%M:%S") })
    States.ConsoleLogs:set(initialLogs)
end

-- Utility functions
local function clamp(num, minV, maxV)
    if num < minV then return minV end
    if num > maxV then return maxV end
    return num
end

local WindowArgs = (Iris.Args and Iris.Args.Window) or {}

local function setWindowFlag(opts, keyName, value)
    local key = WindowArgs[keyName]
    if key ~= nil then opts[key] = value end
end

local function createFixedWindowOptions(title)
    local opts = { title }
    setWindowFlag(opts, "NoClose", true)
    setWindowFlag(opts, "NoTitleBar", false)
    setWindowFlag(opts, "NoMove", true)
    setWindowFlag(opts, "NoResize", true)
    setWindowFlag(opts, "NoCollapse", true)
    return opts
end

local function padRight(inputText, width)
    local input = tostring(inputText or "")
    local pad = width - #input
    if pad > 0 then return input .. string.rep(" ", pad) end
    return input
end

-- Tab nav: direct color on .Instance to avoid UpdateGlobalConfig per-frame noise
local NAV_TABS = {
    { name = "console",  label = "Console"  },
    { name = "editor",   label = "Editor"   },
    { name = "search",   label = "Search"   },
    { name = "objects",  label = "Objects"  },
    { name = "remotes",  label = "Remotes"  },
    { name = "tweaks",   label = "Tweaks"   },
    { name = "settings", label = "Settings" },
}

local function renderNavButtons()
    local activeTab = States.ActiveTab:get()
    local hasMeta   = States.HasMetatable:get()

    for _, tab in ipairs(NAV_TABS) do
        local selected = activeTab == tab.name
        local isLocked = (tab.name == "remotes") and not hasMeta

        local prefix = isLocked and "[!]" or (selected and "[X]" or "[ ]")
        local btn = Iris.Button({ prefix .. " " .. padRight(tab.label, 12) })

        -- Set color directly on the Roblox instance — no UpdateGlobalConfig needed
        pcall(function()
            local inst = btn.Instance
            if inst then
                if isLocked then
                    inst.BackgroundColor3 = Color3.fromRGB(140, 35, 35)
                elseif selected then
                    inst.BackgroundColor3 = COLORS.AccentBlue
                else
                    inst.BackgroundColor3 = COLORS.BgTertiary
                end
            end
        end)

        if btn.clicked then
            States.ActiveTab:set(tab.name)
        end
    end
end

local function addToHistory(code)
    local history = States.ExecutionHistory:get()
    table.insert(history, 1, { code = code, time = os.date("%H:%M:%S"), status = "OK" })
    if #history > 50 then table.remove(history, #history) end
    States.ExecutionHistory:set(history)
end

local function addToFavorites(code, name)
    local favs = States.Favorites:get()
    table.insert(favs, { name = name or ("Script " .. os.date("%H:%M:%S")), code = code })
    States.Favorites:set(favs)
end

local function runSearch()
    local query = string.lower(States.SearchQuery:get() or "")
    local mode = States.SearchMode:get()
    local maxResults = States.MaxResults:get()
    local results = {}

    for _, obj in ipairs(game:GetDescendants()) do
        local include = false
        if mode == "all" then
            include = true
        elseif mode == "remotes" then
            include = obj:IsA("RemoteEvent") or obj:IsA("RemoteFunction")
        elseif mode == "folders" then
            include = obj:IsA("Folder")
        elseif mode == "scripts" then
            include = obj:IsA("LocalScript") or obj:IsA("Script") or obj:IsA("ModuleScript")
        end

        if include then
            local nameOk = query == "" or string.find(string.lower(obj.Name), query, 1, true) ~= nil
            if nameOk then
                table.insert(results, obj.ClassName .. " | " .. obj:GetFullName())
                if #results >= maxResults then break end
            end
        end
    end
    States.SearchResults:set(results)
end

local function enableFly()
    local lp = game:GetService("Players").LocalPlayer
    if not lp or not lp.Character then return end
    
    local hrp = lp.Character:FindFirstChild("HumanoidRootPart")
    if not hrp then return end
    
    local bv = Instance.new("BodyVelocity", hrp)
    bv.MaxForce = Vector3.new(9e9, 9e9, 9e9)
    bv.Velocity = Vector3.zero
    
    local bg = Instance.new("BodyGyro", hrp)
    bg.MaxTorque = Vector3.new(9e9, 9e9, 9e9)
    bg.P = 9000
    bg.CFrame = hrp.CFrame
    
    GENV._FLY_VELOCITY = bv
    GENV._FLY_GYRO = bg
    
    task.spawn(function()
        while States.FlyEnabled:get() do
            if hrp and States.FlyEnabled:get() then
                bv.Velocity = hrp.CFrame.LookVector * 50
                bg.CFrame = hrp.CFrame
            end
            task.wait(0.03)
        end
    end)
end

local function disableFly()
    if GENV._FLY_VELOCITY then GENV._FLY_VELOCITY:Destroy() GENV._FLY_VELOCITY = nil end
    if GENV._FLY_GYRO then GENV._FLY_GYRO:Destroy() GENV._FLY_GYRO = nil end
end

-- F1 Toggle
if not GENV._VSRXVC_F1_CONNECTED then
    GENV._VSRXVC_F1_CONNECTED = true
    UserInputService.InputBegan:Connect(function(input, processed)
        if not processed and input.KeyCode == Enum.KeyCode.F1 then
            States.Opened:set(not States.Opened:get())
        end
    end)
end

if GENV._VSRXVC_UI_CONNECTION then
    pcall(function() GENV._VSRXVC_UI_CONNECTION:Disconnect() end)
end

GENV._VSRXVC_UI_CONNECTION = Iris:Connect(function()
    if GENV._VSRXVC_MENU_RUN_ID ~= MENU_RUN_ID then return end
    if not States.Opened:get() then return end

    -- Navigation Window
    Iris.Window(createFixedWindowOptions("VSRXVC"), {
        size = Iris.State(Vector2.new(240, 650)),
        position = Iris.State(Vector2.new(20, 80))
    })

    Iris.Text({ "VSRXVC - Visual Studio Roblox Vibe Coding" })
    Iris.Text({ "Debugging Tools" })
    Iris.Separator()

    renderNavButtons()

    Iris.End()

    -- Content Window
    Iris.Window(createFixedWindowOptions("Content"), {
        size = Iris.State(Vector2.new(850, 650)),
        position = Iris.State(Vector2.new(270, 80))
    })

    local activeTab = States.ActiveTab:get()
    Iris.Text({ "[" .. string.upper(activeTab) .. "]" })
    Iris.Separator()

    if activeTab == "console" then pcall(renderConsoleTab) end
    if activeTab == "editor" then pcall(renderEditorTab) end
    if activeTab == "search" then pcall(renderSearchTab) end
    if activeTab == "objects" then pcall(renderObjectsTab) end
    if activeTab == "remotes" then pcall(renderRemotesTab) end
    if activeTab == "tweaks" then pcall(renderTweaksTab) end
    if activeTab == "settings" then pcall(renderSettingsTab) end

    Iris.End()
end)

-- ============================================================================
-- TAB RENDERERS
-- ============================================================================

function renderConsoleTab()
    Iris.Text({ "CONSOLE OUTPUT" })
    Iris.Separator()
    
    if Iris.SmallButton({ "[CLEAR]" }).clicked then
        States.ConsoleLogs:set({})
    end
    if Iris.SmallButton({ "[COPY]" }).clicked then
        local logs = States.ConsoleLogs:get()
        local text = ""
        for _, log in ipairs(logs) do
            text = text .. "[" .. log.time .. "] " .. log.level .. ": " .. log.text .. "\n"
        end
        pcall(function() setclipboard(text) end)
    end
    
    Iris.Text({ "Lines: " .. #States.ConsoleLogs:get() })
    Iris.Separator()
    
    local logs = States.ConsoleLogs:get()
    if #logs == 0 then
        Iris.Text({ "(no logs yet)" })
    else
        for i = math.max(1, #logs - 30), #logs do
            local log = logs[i]
            Iris.Text({ "[" .. log.time .. "] " .. log.text })
        end
    end
end

function renderEditorTab()
    Iris.Text({ "CODE EDITOR" })
    Iris.Separator()
    
    if Iris.Button({ "[EXECUTE]" }).clicked then
        local code = States.Code:get()
        if code and #code > 0 then
            local func, err = loadstring(code)
            if func then
                addToHistory(code)
                task.spawn(func)
                table.insert(States.ConsoleLogs:get(), { level = "success", text = "Script executed", time = os.date("%H:%M:%S") })
            else
                table.insert(States.ConsoleLogs:get(), { level = "error", text = "Syntax: " .. tostring(err), time = os.date("%H:%M:%S") })
            end
        end
    end
    if Iris.SmallButton({ "[FAV]" }).clicked then
        addToFavorites(States.Code:get(), "Script " .. os.date("%H:%M:%S"))
    end
    if Iris.SmallButton({ "[DEL]" }).clicked then
        States.Code:set("")
    end
    
    Iris.Separator()
    
    local codeInput = Iris.InputText({ "##CodeInput" }, { value = States.Code })
    pcall(function()
        local inputField = codeInput.Instance.InputField
        if inputField and not inputField:GetAttribute("VSRX_Configured") then
            inputField:SetAttribute("VSRX_Configured", true)
            inputField.MultiLine = true
            inputField.TextWrapped = false
            inputField.ClearTextOnFocus = false
            inputField.Font = Enum.Font.Code
            inputField.TextXAlignment = Enum.TextXAlignment.Left
            inputField.TextYAlignment = Enum.TextYAlignment.Top
            inputField.Size = UDim2.new(1, 0, 0, 300)
            inputField.BackgroundColor3 = COLORS.BgTertiary
        end
        if codeInput.Instance.TextLabel then codeInput.Instance.TextLabel.Visible = false end
    end)
    
    Iris.Separator()
    Iris.Text({ "Font: " .. States.EditorFontSize:get() })
    if Iris.SmallButton({ "-" }).clicked then
        States.EditorFontSize:set(math.max(10, States.EditorFontSize:get() - 1))
    end
    if Iris.SmallButton({ "+" }).clicked then
        States.EditorFontSize:set(math.min(20, States.EditorFontSize:get() + 1))
    end
    
    Iris.Separator()
    Iris.Text({ "FAVORITES (" .. #States.Favorites:get() .. ")" })
    
    local favs = States.Favorites:get()
    for i, fav in ipairs(favs) do
        if Iris.SmallButton({ "[X]" }).clicked then
            table.remove(favs, i)
            States.Favorites:set(favs)
        end
        if Iris.Button({ fav.name }).clicked then
            States.Code:set(fav.code)
        end
    end
end

function renderSearchTab()
    Iris.Text({ "GAME EXPLORER" })
    Iris.Separator()
    
    if Iris.Button({ "All" }).clicked then States.SearchMode:set("all") end
    if Iris.Button({ "Remotes" }).clicked then States.SearchMode:set("remotes") end
    if Iris.Button({ "Folders" }).clicked then States.SearchMode:set("folders") end
    if Iris.Button({ "Scripts" }).clicked then States.SearchMode:set("scripts") end
    
    Iris.Separator()
    Iris.InputText({ "##SearchInput" }, { value = States.SearchQuery })
    
    if Iris.Button({ "[SEARCH]" }).clicked then runSearch() end
    
    Iris.Separator()
    Iris.Text({ "Results: " .. #States.SearchResults:get() })
    
    local results = States.SearchResults:get()
    for _, result in ipairs(results) do
        if Iris.SmallButton({ "[CP]" }).clicked then
            pcall(function() setclipboard(result) end)
        end
        Iris.Text({ result })
    end
end

function renderObjectsTab()
    Iris.Text({ "OBJECT INSPECTOR" })
    Iris.Separator()
    
    if Iris.Button({ "REFRESH" }).clicked then
        local list = {}
        for _, obj in ipairs(game:GetDescendants()) do
            table.insert(list, obj)
        end
        States.ObjectsList:set(list)
    end
    
    Iris.Separator()
    Iris.InputText({ "##ObjFilter" }, { value = States.SearchQuery })
    
    Iris.Text({ "Objects: " .. #States.ObjectsList:get() })
    Iris.Separator()
    
    local objs = States.ObjectsList:get()
    local query = string.lower(States.SearchQuery:get() or "")
    
    for i, obj in ipairs(objs) do
        if i > 50 then break end
        if query == "" or string.find(string.lower(obj.Name), query, 1, true) then
            if Iris.Button({ obj.ClassName .. " | " .. obj.Name }).clicked then
                States.InspectedObject:set(obj)
            end
        end
    end
end

function renderTweaksTab()
    Iris.Text({ "PLAYER TWEAKS" })
    Iris.Separator()
    
    local lp = game:GetService("Players").LocalPlayer
    if not lp or not lp.Character then
        Iris.Text({ "(no character)" })
        return
    end
    
    local h = lp.Character:FindFirstChildOfClass("Humanoid")
    if not h then
        Iris.Text({ "(no humanoid)" })
        return
    end
    
    Iris.Text({ "HP: " .. h.Health .. "/" .. h.MaxHealth })
    Iris.Text({ "Speed: " .. h.WalkSpeed })
    Iris.Text({ "Jump: " .. h.JumpPower })
    Iris.Separator()
    
    Iris.Text({ "Walk: " .. States.TweakWalkSpeed:get() })
    if Iris.SmallButton({ "-" }).clicked then
        States.TweakWalkSpeed:set(clamp(States.TweakWalkSpeed:get() - 1, 0, 200))
    end
    if Iris.SmallButton({ "+" }).clicked then
        States.TweakWalkSpeed:set(clamp(States.TweakWalkSpeed:get() + 1, 0, 200))
    end
    if Iris.Button({ "APPLY" }).clicked then
        h.WalkSpeed = States.TweakWalkSpeed:get()
        table.insert(States.ConsoleLogs:get(), { level = "success", text = "Walk speed: " .. States.TweakWalkSpeed:get(), time = os.date("%H:%M:%S") })
    end
    
    Iris.Separator()
    
    Iris.Text({ "Jump: " .. States.TweakJumpPower:get() })
    if Iris.SmallButton({ "-" }).clicked then
        States.TweakJumpPower:set(clamp(States.TweakJumpPower:get() - 1, 0, 200))
    end
    if Iris.SmallButton({ "+" }).clicked then
        States.TweakJumpPower:set(clamp(States.TweakJumpPower:get() + 1, 0, 200))
    end
    if Iris.Button({ "APPLY" }).clicked then
        h.JumpPower = States.TweakJumpPower:get()
        table.insert(States.ConsoleLogs:get(), { level = "success", text = "Jump power: " .. States.TweakJumpPower:get(), time = os.date("%H:%M:%S") })
    end
    
    Iris.Separator()
    
    if Iris.Button({ States.FlyEnabled:get() and "[STOP FLY]" or "[START FLY]" }).clicked then
        States.FlyEnabled:set(not States.FlyEnabled:get())
        if States.FlyEnabled:get() then
            enableFly()
            table.insert(States.ConsoleLogs:get(), { level = "success", text = "Fly enabled", time = os.date("%H:%M:%S") })
        else
            disableFly()
            table.insert(States.ConsoleLogs:get(), { level = "info", text = "Fly disabled", time = os.date("%H:%M:%S") })
        end
    end
end

function renderRemotesTab()
    Iris.Text({ "REMOTE EVENTS & FUNCTIONS" })
    Iris.Separator()

    if not States.HasMetatable:get() then
        Iris.Text({ "[!] getrawmetatable: NOT AVAILABLE" })
        Iris.Text({ "Remote sniffing requires getrawmetatable." })
        Iris.Text({ "This executor does not support it." })
        Iris.Separator()
    end

    if Iris.Button({ "[SCAN] Scan All Remotes" }).clicked then
        local results = {}
        for _, v in ipairs(game:GetDescendants()) do
            if v:IsA("RemoteEvent") or v:IsA("RemoteFunction") then
                table.insert(results, v.ClassName .. " | " .. v:GetFullName())
            end
        end
        States.SearchResults:set(results)
        table.insert(States.ConsoleLogs:get(), { level = "success", text = "Found " .. #results .. " remotes", time = os.date("%H:%M:%S") })
    end

    Iris.Separator()
    local results = States.SearchResults:get()
    Iris.Text({ "Found: " .. #results })
    Iris.Separator()

    for i, result in ipairs(results) do
        if i > 60 then break end
        Iris.Text({ result })
    end
end

function renderSettingsTab()
    Iris.Text({ "SETTINGS" })
    Iris.Separator()
    
    Iris.Text({ "Mode: " .. (IS_STANDALONE and "STANDALONE" or "CONNECTED") })
    if IS_STANDALONE then
        Iris.Text({ "(no VSRX extension)" })
    else
        Iris.Text({ "Bridge: " .. baseUrl })
    end
    
    Iris.Separator()
    Iris.Text({ "CAPABILITIES" })
    Iris.Text({ "getrawmetatable: " .. (States.HasMetatable:get() and "YES" or "NO") })
    Iris.Text({ "hookfunction: " .. (States.HasHookfunction:get() and "YES" or "NO") })
    
    Iris.Separator()
    Iris.Text({ "Max results: " .. States.MaxResults:get() })
    if Iris.SmallButton({ "-" }).clicked then
        States.MaxResults:set(clamp(States.MaxResults:get() - 10, 10, 500))
    end
    if Iris.SmallButton({ "+" }).clicked then
        States.MaxResults:set(clamp(States.MaxResults:get() + 10, 10, 500))
    end
    
    Iris.Separator()
    if not IS_STANDALONE then
        if Iris.Button({ "COPY BRIDGE URL" }).clicked then
            pcall(function() setclipboard(baseUrl) end)
        end
    end
end

print("[MENU] Loaded successfully")
