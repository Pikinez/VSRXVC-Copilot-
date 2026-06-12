---@diagnostic disable: undefined-global
if getgenv().VSRX_RANDOM_ROULETTE then
	warn("Random roulette already running")
	return
end
getgenv().VSRX_RANDOM_ROULETTE = true

local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local lp = Players.LocalPlayer

local function getCharacter()
	return lp.Character or lp.CharacterAdded:Wait()
end

local function randomOtherPlayer()
	local list = {}
	for _, p in ipairs(Players:GetPlayers()) do
		if p ~= lp and p.Character and p.Character:FindFirstChild("HumanoidRootPart") then
			table.insert(list, p)
		end
	end
	if #list == 0 then
		return nil
	end
	return list[math.random(1, #list)]
end

local function speedBurst()
	local char = getCharacter()
	local hum = char:FindFirstChildOfClass("Humanoid")
	if not hum then return end
	local old = hum.WalkSpeed
	hum.WalkSpeed = old + 20
	print("[Roulette] Speed burst")
	task.delay(4, function()
		if hum and hum.Parent then
			hum.WalkSpeed = old
		end
	end)
end

local function highJump()
	local char = getCharacter()
	local hum = char:FindFirstChildOfClass("Humanoid")
	if not hum then return end
	local old = hum.JumpPower
	hum.JumpPower = old + 45
	print("[Roulette] High jump")
	task.delay(4, function()
		if hum and hum.Parent then
			hum.JumpPower = old
		end
	end)
end

local function blinkToPlayer()
	local target = randomOtherPlayer()
	if not target then
		warn("[Roulette] No players to blink to")
		return
	end
	local myChar = getCharacter()
	local myRoot = myChar:FindFirstChild("HumanoidRootPart")
	local targetRoot = target.Character and target.Character:FindFirstChild("HumanoidRootPart")
	if myRoot and targetRoot then
		myRoot.CFrame = targetRoot.CFrame + Vector3.new(2, 0, 0)
		print("[Roulette] Blinked to " .. target.Name)
	end
end

local spinConnection
local function spinMode()
	local char = getCharacter()
	local root = char:FindFirstChild("HumanoidRootPart")
	if not root then return end
	print("[Roulette] Spin mode")
	if spinConnection then
		spinConnection:Disconnect()
	end
	local stopAt = tick() + 3.5
	spinConnection = RunService.RenderStepped:Connect(function(dt)
		if not root.Parent or tick() > stopAt then
			if spinConnection then spinConnection:Disconnect() end
			spinConnection = nil
			return
		end
		root.CFrame = root.CFrame * CFrame.Angles(0, math.rad(500 * dt), 0)
	end)
end

math.randomseed(os.clock() * 1e6)

local actions = { speedBurst, highJump, blinkToPlayer, spinMode }
print("[Roulette] Running random effects every 6s. Re-run to reset.")

while getgenv().VSRX_RANDOM_ROULETTE do
	task.wait(6)
	actions[math.random(1, #actions)]()
end