-- Realistic player-to-player walker with non-shortest path detours
local Players = game:GetService("Players")
local PathfindingService = game:GetService("PathfindingService")
local RunService = game:GetService("RunService")

local LOG = "[WALKER-V4]"
local ENV = getgenv and getgenv() or _G

if ENV.__WALKER_STOP then
    pcall(ENV.__WALKER_STOP)
end
if ENV.__WALKER_V2_STOP then
    pcall(ENV.__WALKER_V2_STOP)
end
if ENV.__WALKER_V3_STOP then
    pcall(ENV.__WALKER_V3_STOP)
end
if ENV.__WALKER_V4_STOP then
    pcall(ENV.__WALKER_V4_STOP)
end

local alive = true
ENV.__WALKER_V4_STOP = function()
    alive = false
end

local Config = {
    loopForever = true,
    rePathAttempts = 3,
    waypointReachTimeout = 3.8,
    targetApproachRadius = 5,
    detourDistance = 10,
    pauseMin = 0.15,
    pauseMax = 0.55,
    cyclePause = 0.55,
    targetMoveRepathDistance = 18,
    maxChaseSecondsPerTarget = 30,
    walkSpeedMin = 14,
    walkSpeedMax = 17,
    maxPathSegmentDistance = 90,
    maxTargetDistance = 650,
}

local localPlayer = Players.LocalPlayer

local function getCharacterParts()
    local character = localPlayer.Character or localPlayer.CharacterAdded:Wait()
    local humanoid = character:WaitForChild("Humanoid")
    local root = character:WaitForChild("HumanoidRootPart")
    return character, humanoid, root
end

local function getTargets()
    local list = {}
    for _, plr in ipairs(Players:GetPlayers()) do
        if plr ~= localPlayer and plr.Character then
            local hum = plr.Character:FindFirstChildOfClass("Humanoid")
            if hum and hum.Health > 0 then
                table.insert(list, { player = plr })
            end
        end
    end
    table.sort(list, function(a, b)
        return a.player.Name < b.player.Name
    end)
    return list
end

local function getTargetRoot(plr)
    if not plr or not plr.Parent then
        return nil
    end
    local char = plr.Character
    if not char then
        return nil
    end
    local hum = char:FindFirstChildOfClass("Humanoid")
    local root = char:FindFirstChild("HumanoidRootPart")
    if not hum or hum.Health <= 0 or not root then
        return nil
    end
    return root
end

local function randomPause()
    task.wait(math.random() * (Config.pauseMax - Config.pauseMin) + Config.pauseMin)
end

local function pointAroundTarget(targetPos)
    local angle = math.rad(math.random(0, 359))
    local r = Config.targetApproachRadius + math.random() * 2
    return targetPos + Vector3.new(math.cos(angle) * r, 0, math.sin(angle) * r)
end

local function detourPoint(startPos, endPos)
    local mid = (startPos + endPos) * 0.5
    local dir = (endPos - startPos)
    if dir.Magnitude < 1 then
        return mid
    end

    local forward = dir.Unit
    local right = forward:Cross(Vector3.new(0, 1, 0))
    if right.Magnitude < 0.1 then
        right = Vector3.new(1, 0, 0)
    else
        right = right.Unit
    end

    local sideSign = (math.random(0, 1) == 0) and -1 or 1
    local distance = Config.detourDistance * (0.65 + math.random() * 0.7)
    return mid + right * sideSign * distance
end

local function splitLongSegment(fromPos, toPos)
    local nodes = {}
    local delta = toPos - fromPos
    local distance = delta.Magnitude
    if distance <= Config.maxPathSegmentDistance then
        nodes[1] = toPos
        return nodes
    end

    local direction = delta.Unit
    local traveled = Config.maxPathSegmentDistance
    while traveled < distance do
        nodes[#nodes + 1] = fromPos + direction * traveled
        traveled = traveled + Config.maxPathSegmentDistance
    end
    nodes[#nodes + 1] = toPos
    return nodes
end

local function moveByPath(humanoid, startPos, endPos, movingReference)
    local path = PathfindingService:CreatePath({
        AgentRadius = 2,
        AgentHeight = 5,
        AgentCanJump = true,
        AgentCanClimb = true,
        WaypointSpacing = 3,
    })

    local okCompute, computeErr = pcall(function()
        path:ComputeAsync(startPos, endPos)
    end)
    if not okCompute then
        return false, "compute error: " .. tostring(computeErr)
    end

    if path.Status ~= Enum.PathStatus.Success then
        return false, "path failed"
    end

    local waypoints = path:GetWaypoints()
    local referenceStart = movingReference and movingReference.Position or nil

    for _, waypoint in ipairs(waypoints) do
        if waypoint.Action == Enum.PathWaypointAction.Jump then
            humanoid.Jump = true
        end

        local reached = false
        local connection
        connection = humanoid.MoveToFinished:Connect(function(ok)
            reached = ok
            if connection then
                connection:Disconnect()
                connection = nil
            end
        end)

        humanoid:MoveTo(waypoint.Position)

        local t0 = os.clock()
        while connection and os.clock() - t0 < Config.waypointReachTimeout do
            if movingReference and referenceStart and movingReference.Parent then
                if (movingReference.Position - referenceStart).Magnitude >= Config.targetMoveRepathDistance then
                    connection:Disconnect()
                    connection = nil
                    return false, "target shifted"
                end
            end
            RunService.Heartbeat:Wait()
        end

        if connection then
            connection:Disconnect()
            connection = nil
        end

        if not reached then
            return false, "waypoint timeout"
        end
    end

    return true
end

local function chooseWalkSpeed(humanoid)
    humanoid.WalkSpeed = Config.walkSpeedMin + math.random() * (Config.walkSpeedMax - Config.walkSpeedMin)
end

local function moveToWithTimeout(humanoid, point, timeoutSec)
    local reached = false
    local connection
    connection = humanoid.MoveToFinished:Connect(function(ok)
        reached = ok
        if connection then
            connection:Disconnect()
            connection = nil
        end
    end)

    humanoid:MoveTo(point)
    local t0 = os.clock()
    while connection and os.clock() - t0 < timeoutSec do
        RunService.Heartbeat:Wait()
    end

    if connection then
        connection:Disconnect()
        connection = nil
    end

    return reached
end

local function moveRealisticToTarget(humanoid, root, targetPlayer)
    local chaseStart = os.clock()

    while alive and os.clock() - chaseStart < Config.maxChaseSecondsPerTarget do
        local targetRoot = getTargetRoot(targetPlayer)
        if not targetRoot then
            return false, "target lost"
        end

        local distance = (targetRoot.Position - root.Position).Magnitude
        if distance > Config.maxTargetDistance then
            return false, "target too far"
        end
        if distance <= Config.targetApproachRadius then
            return true
        end

        chooseWalkSpeed(humanoid)

        local nearPos = pointAroundTarget(targetRoot.Position)
        local d1 = detourPoint(root.Position, nearPos)
        local d2 = detourPoint(d1, nearPos)
        local route = { d1, d2, nearPos }
        local reachedSegment = true

        for _, node in ipairs(route) do
            local hops = splitLongSegment(root.Position, node)
            for _, hopNode in ipairs(hops) do
                local success = false
                for _ = 1, Config.rePathAttempts do
                    local ok, err = moveByPath(humanoid, root.Position, hopNode, targetRoot)
                    if ok then
                        success = true
                        break
                    end

                    if err == "target shifted" then
                        targetRoot = getTargetRoot(targetPlayer)
                        if not targetRoot then
                            return false, "target lost"
                        end
                    else
                        randomPause()
                    end
                end

                if not success then
                    reachedSegment = false
                    break
                end

                local refreshedRoot = getTargetRoot(targetPlayer)
                if not refreshedRoot then
                    return false, "target lost"
                end
                targetRoot = refreshedRoot

                local nearNow = (targetRoot.Position - root.Position).Magnitude <= Config.targetApproachRadius
                if nearNow then
                    return true
                end

                randomPause()
            end

            if not reachedSegment then
                break
            end

            local refreshedRoot = getTargetRoot(targetPlayer)
            if not refreshedRoot then
                return false, "target lost"
            end
            targetRoot = refreshedRoot

            if (targetRoot.Position - root.Position).Magnitude <= Config.targetApproachRadius then
                return true
            end

            if os.clock() - chaseStart < Config.maxChaseSecondsPerTarget * 0.8 then
                if (targetRoot.Position - nearPos).Magnitude > Config.targetMoveRepathDistance * 1.5 then
                    randomPause()
                end
            end
        end

        if not reachedSegment then
            local refresh = getTargetRoot(targetPlayer)
            if not refresh then
                return false, "target lost"
            end

            local distNow = (refresh.Position - root.Position).Magnitude
            if distNow <= 35 then
                local reached = moveToWithTimeout(humanoid, refresh.Position, 1.8)
                if reached then
                    return true
                end
            end

            randomPause()
        end
    end

    return false, "chase timeout"
end

local function main()
    math.randomseed(tick())
    local _, humanoid, root = getCharacterParts()
    local baseWalkSpeed = humanoid.WalkSpeed
    print(LOG .. " Started")

    while Config.loopForever and alive do
        local targets = getTargets()
        if #targets == 0 then
            print(LOG .. " No targets")
            task.wait(1)
        else
            for index, entry in ipairs(targets) do
                local targetRoot = getTargetRoot(entry.player)
                if not targetRoot then
                    print(string.format("%s %d/%d %s skipped (left)", LOG, index, #targets, entry.player.Name))
                else
                    print(string.format("%s %d/%d moving to %s", LOG, index, #targets, entry.player.Name))
                    local ok, err = moveRealisticToTarget(humanoid, root, entry.player)
                    if ok then
                        print(string.format("%s reached near %s", LOG, entry.player.Name))
                    else
                        print(string.format("%s failed near %s: %s", LOG, entry.player.Name, tostring(err)))
                    end
                    randomPause()
                end
            end
            task.wait(Config.cyclePause)
        end

        if humanoid.Health <= 0 then
            print(LOG .. " Local character died, waiting respawn")
            local _, newHumanoid, newRoot = getCharacterParts()
            humanoid = newHumanoid
            root = newRoot
            baseWalkSpeed = humanoid.WalkSpeed
            task.wait(0.8)
        end
    end

    if humanoid and humanoid.Parent then
        humanoid.WalkSpeed = baseWalkSpeed
    end
end

task.spawn(function()
    local ok, err = pcall(main)
    if not ok then
        warn(LOG .. " Error: " .. tostring(err))
    else
        print(LOG .. " Stopped")
    end
end)


