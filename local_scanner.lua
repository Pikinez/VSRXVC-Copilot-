local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local Camera = workspace.CurrentCamera

local LocalPlayer = Players.LocalPlayer

local config = {
	cooldown = 8,
	duration = 4,
	highlightFill = Color3.fromRGB(255, 90, 90),
	auraColor = Color3.fromRGB(80, 170, 255),
	launchStrength = 34,
	spinStrength = 18,
	cameraJitter = 0.7,
}

local state = {
	active = false,
	lastRun = 0,
	target = nil,
	highlight = nil,
	gui = nil,
	aura = nil,
	spinGyro = nil,
	spinVelocity = nil,
	originalAutoRotate = nil,
}

local funnyLines = {
	"target acquired, dignity lost",
	"scanner says: this one is funny",
	"boing protocol engaged",
	"pinged a random goblin",
	"the camera has chosen chaos",
}

local function getCharacter(player)
	return player and player.Character or nil
end

local function getHumanoidRootPart(player)
	local character = getCharacter(player)
	if not character then
		return nil
	end
	return character:FindFirstChild("HumanoidRootPart")
end

local function getAlivePlayers()
	local candidates = {}

	for _, player in ipairs(Players:GetPlayers()) do
		if player ~= LocalPlayer then
			local character = getCharacter(player)
			local humanoid = character and character:FindFirstChildOfClass("Humanoid")
			local hrp = character and character:FindFirstChild("HumanoidRootPart")

			if humanoid and hrp and humanoid.Health > 0 then
				candidates[#candidates + 1] = player
			end
		end
	end

	return candidates
end

local function destroyState()
	if state.highlight then
		state.highlight:Destroy()
		state.highlight = nil
	end

	if state.gui then
		state.gui:Destroy()
		state.gui = nil
	end

	if state.aura then
		state.aura:Destroy()
		state.aura = nil
	end

	if state.spinGyro then
		state.spinGyro:Destroy()
		state.spinGyro = nil
	end

	if state.spinVelocity then
		state.spinVelocity:Destroy()
		state.spinVelocity = nil
	end

	local character = LocalPlayer.Character
	local humanoid = character and character:FindFirstChildOfClass("Humanoid")
	if humanoid and state.originalAutoRotate ~= nil then
		humanoid.AutoRotate = state.originalAutoRotate
	end
	state.originalAutoRotate = nil

	state.target = nil
	state.active = false
end

local function createHud(targetPlayer)
	local gui = Instance.new("ScreenGui")
	gui.Name = "LocalScannerGui"
	gui.ResetOnSpawn = false
	gui.IgnoreGuiInset = true
	gui.Parent = LocalPlayer:WaitForChild("PlayerGui")

	local panel = Instance.new("Frame")
	panel.AnchorPoint = Vector2.new(0.5, 0)
	panel.Position = UDim2.new(0.5, 0, 0.1, 0)
	panel.Size = UDim2.new(0, 340, 0, 74)
	panel.BackgroundColor3 = Color3.fromRGB(18, 18, 24)
	panel.BackgroundTransparency = 0.1
	panel.BorderSizePixel = 0
	panel.Parent = gui

	local corner = Instance.new("UICorner")
	corner.CornerRadius = UDim.new(0, 12)
	corner.Parent = panel

	local stroke = Instance.new("UIStroke")
	stroke.Color = config.highlightFill
	stroke.Thickness = 1.5
	stroke.Transparency = 0.2
	stroke.Parent = panel

	local title = Instance.new("TextLabel")
	title.BackgroundTransparency = 1
	title.Position = UDim2.new(0, 16, 0, 10)
	title.Size = UDim2.new(1, -32, 0, 24)
	title.Font = Enum.Font.GothamBold
	title.TextSize = 19
	title.TextXAlignment = Enum.TextXAlignment.Left
	title.TextColor3 = Color3.fromRGB(255, 255, 255)
	title.Text = "Headspin Scanner"
	title.Parent = panel

	local info = Instance.new("TextLabel")
	info.BackgroundTransparency = 1
	info.Position = UDim2.new(0, 16, 0, 36)
	info.Size = UDim2.new(1, -32, 0, 24)
	info.Font = Enum.Font.Gotham
	info.TextSize = 16
	info.TextXAlignment = Enum.TextXAlignment.Left
	info.TextColor3 = Color3.fromRGB(220, 220, 220)
	info.Text = funnyLines[math.random(1, #funnyLines)] .. " | " .. targetPlayer.Name
	info.Parent = panel

	return gui
end

local function createAura()
	local character = LocalPlayer.Character or LocalPlayer.CharacterAdded:Wait()
	local hrp = character:WaitForChild("HumanoidRootPart")

	local attachment = Instance.new("Attachment")
	attachment.Name = "ScannerAuraAttachment"
	attachment.Parent = hrp

	local emitter = Instance.new("ParticleEmitter")
	emitter.Name = "ScannerAura"
	emitter.Rate = 24
	emitter.Lifetime = NumberRange.new(0.6, 1)
	emitter.Speed = NumberRange.new(1.5, 3)
	emitter.SpreadAngle = Vector2.new(180, 180)
	emitter.LightEmission = 0.75
	emitter.Color = ColorSequence.new(config.auraColor)
	emitter.Size = NumberSequence.new({
		NumberSequenceKeypoint.new(0, 0.18),
		NumberSequenceKeypoint.new(1, 0),
	})
	emitter.Parent = attachment
	state.aura = attachment

	task.delay(config.duration, function()
		if attachment and attachment.Parent then
			attachment:Destroy()
		end
	end)
end

local function startHeadspin()
	local character = LocalPlayer.Character or LocalPlayer.CharacterAdded:Wait()
	local humanoid = character:WaitForChild("Humanoid")
	local hrp = character:WaitForChild("HumanoidRootPart")

	state.originalAutoRotate = humanoid.AutoRotate
	humanoid.AutoRotate = false

	local gyro = Instance.new("BodyGyro")
	gyro.Name = "HeadspinGyro"
	gyro.MaxTorque = Vector3.new(9e9, 9e9, 9e9)
	gyro.P = 70000
	gyro.D = 1200
	gyro.CFrame = hrp.CFrame * CFrame.Angles(math.rad(90), 0, 0)
	gyro.Parent = hrp

	local spin = Instance.new("BodyAngularVelocity")
	spin.Name = "HeadspinVelocity"
	spin.MaxTorque = Vector3.new(9e9, 9e9, 9e9)
	spin.AngularVelocity = Vector3.new(0, 22, 0)
	spin.P = 1250
	spin.Parent = hrp

	state.spinGyro = gyro
	state.spinVelocity = spin

	task.delay(config.duration, function()
		destroyState()
	end)
end

local function doFunnyLaunch()
	local character = LocalPlayer.Character
	if not character then
		return
	end

	local humanoid = character:FindFirstChildOfClass("Humanoid")
	local hrp = character:FindFirstChild("HumanoidRootPart")
	if not humanoid or not hrp then
		return
	end

	local x = math.random(-config.launchStrength, config.launchStrength)
	local z = math.random(-config.launchStrength, config.launchStrength)
	local y = config.launchStrength + math.random(8, 16)

	pcall(function()
		hrp.AssemblyLinearVelocity = Vector3.new(x, y, z)
		hrp.AssemblyAngularVelocity = Vector3.new(0, config.spinStrength, 0)
	end)

	task.delay(0.35, function()
		if hrp and hrp.Parent then
			pcall(function()
				hrp.AssemblyAngularVelocity = Vector3.zero
			end)
		end
	end)
end

local function createHighlight(targetPlayer)
	local highlight = Instance.new("Highlight")
	highlight.Name = "ScannerHighlight"
	highlight.Adornee = getCharacter(targetPlayer)
	highlight.FillColor = config.highlightFill
	highlight.OutlineColor = Color3.fromRGB(255, 255, 255)
	highlight.FillTransparency = 0.45
	highlight.OutlineTransparency = 0.1
	highlight.DepthMode = Enum.HighlightDepthMode.AlwaysOnTop
	highlight.Parent = targetPlayer.Character
	return highlight
end

local function pickRandomTarget()
	local candidates = getAlivePlayers()
	if #candidates == 0 then
		return nil
	end
	return candidates[math.random(1, #candidates)]
end

local function focusCamera(targetPlayer)
	local hrp = getHumanoidRootPart(targetPlayer)
	if not hrp then
		return
	end

	local previousType = Camera.CameraType
	local previousSubject = Camera.CameraSubject
	Camera.CameraType = Enum.CameraType.Scriptable

	local started = os.clock()
	while os.clock() - started < config.duration do
		if not hrp.Parent then
			break
		end

		local pos = hrp.Position
		local jitterX = (math.random() - 0.5) * config.cameraJitter
		local jitterY = (math.random() - 0.5) * config.cameraJitter * 0.5
		local jitterZ = (math.random() - 0.5) * config.cameraJitter
		Camera.CFrame = CFrame.new(pos + Vector3.new(jitterX, 10 + jitterY, 18 + jitterZ), pos)
		RunService.RenderStepped:Wait()
	end

	Camera.CameraType = previousType
	Camera.CameraSubject = previousSubject
end

local function runScanner()
	if state.active then
		return
	end

	if os.clock() - state.lastRun < config.cooldown then
		return
	end

	local target = pickRandomTarget()
	if not target then
		return
	end

	state.active = true
	state.lastRun = os.clock()
	state.target = target
	state.highlight = createHighlight(target)
	state.gui = createHud(target)

	createAura()
	doFunnyLaunch()
	startHeadspin()

	task.spawn(function()
		focusCamera(target)
		task.wait(config.duration)
	end)
end

math.randomseed(os.clock() * 1000)

Players.PlayerAdded:Connect(function()
	task.wait(1)
end)

LocalPlayer.CharacterAdded:Connect(function()
	if state.active then
		destroyState()
	end
end)

print("Local scanner loaded")

task.spawn(function()
	while true do
		task.wait(config.cooldown)
		runScanner()
	end
end)
