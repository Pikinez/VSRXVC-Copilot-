import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { VSRXServer } from './server';

let server: VSRXServer;
let statusBarItem: vscode.StatusBarItem;
let runButton: vscode.StatusBarItem;
let savedScriptsButton: vscode.StatusBarItem;
let scriptHubButton: vscode.StatusBarItem;
let consolePanel: vscode.WebviewPanel | undefined;
let noClientGuidePanel: vscode.WebviewPanel | undefined;
let logHistory: { ts: string; typeLabel: string; player: string; message: string; count: number }[] = [];
const LOG_HISTORY_MAX = 500;
let logBuffer: { message: string, type: number, playerName: string, count: number } | null = null;
let logBufferTimeout: NodeJS.Timeout | null = null;
let lastStatusBarCount = -1;
let noClientGuideLastAutoShowAt = 0;
let noClientGuideLastClosedAt = 0;
let lastExecutedScript = '';
let scriptHistory: { ts: string; preview: string; script: string }[] = [];
const SCRIPT_HISTORY_MAX = 50;
let extensionContext: vscode.ExtensionContext | undefined;
let scriptHistoryPanel: vscode.WebviewPanel | undefined;
let guiInteractionPanel: vscode.WebviewPanel | undefined;
import * as https from 'https';

function notify(msg: string) {
    const config = vscode.workspace.getConfiguration('vsrx');
    if (config.get<boolean>('showNotifications') !== false) {
        vscode.window.showInformationMessage(msg);
    }
}

export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;
    server = new VSRXServer();
    server.start();

    // Restore script history from globalState
    const saved = context.globalState.get<{ ts: string; preview: string; script: string }[]>('vsrxScriptHistory');
    if (Array.isArray(saved)) { scriptHistory = saved; }

    // Generate or retrieve persistent auth token
    let authToken = context.globalState.get<string>('vsrxAuthToken');
    if (!authToken) {
        authToken = require('crypto').randomUUID() as string;
        context.globalState.update('vsrxAuthToken', authToken);
    }
    server.setAuthToken(authToken);

    const config = vscode.workspace.getConfiguration('vsrx');
    server.consoleEnabled = config.get<boolean>('enableConsoleCapture') !== false;
    server.internalUIEnabled = config.get<boolean>('enableInternalUI') === true;
    server.showUIOnLoad = config.get<boolean>('showUIOnLoad') === true;
    server.defaultSavePath = config.get<string>('defaultSavePath') || "";

    if (server.consoleEnabled) {
        setupConsole();
    }

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.showClients', async () => {
            await showClientsMenu();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.runScript', () => {
            if (server.hasClients()) {
                runScript();
            } else {
                const noClientGuideConfig = getNoClientGuideConfig();
                void showNoClientGuide(false, noClientGuideConfig.autoCopyOnOpen);
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.saveScript', async () => {
            await saveScript();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.showSavedScripts', async () => {
            await showSavedScripts();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.showScriptHub', async () => {
            await showScriptHub();
        })
    );

    // Command callable by Copilot Agent or other tools with a script string
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.executeScriptText', (script: string) => {
            if (!script || typeof script !== 'string' || !script.trim()) {
                vscode.window.showErrorMessage('VSRXVC: No script text provided.');
                return;
            }
            if (!server.hasClients()) {
                vscode.window.showWarningMessage('VSRXVC: No Roblox clients connected. Run the loader script first.');
                return;
            }
            const count = server.executeScriptFromAgent(script);
            notify(`VSRXVC: Script queued for ${count} client(s).`);
        })
    );

    // Open keyboard shortcuts filtered to VSRX so users can remap hotkeys
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.configureHotkey', () => {
            vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'vsrx');
        })
    );

    // Setup Copilot instruction + agent files in the current workspace
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.setupCopilotFiles', async () => {
            await setupCopilotFiles(context, true);
        })
    );

    setupCopilotFiles(context, false);

    // Run selected text (or full file) in Roblox — Ctrl+F5
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.runSelection', () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) { vscode.window.showErrorMessage('VSRXVC: No active editor.'); return; }
            const sel = editor.selection;
            const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
            if (!text.trim()) { vscode.window.showErrorMessage('VSRXVC: Nothing to run.'); return; }
            if (!server.hasClients()) {
                vscode.window.showWarningMessage('VSRXVC: No Roblox clients connected.');
                return;
            }
            executeRawScript(text);
        })
    );

    // Open / reveal WebView console
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.showConsole', () => {
            setupConsole();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.clearConsole', () => {
            logHistory = [];
            if (consolePanel) {
                try { consolePanel.webview.postMessage({ type: 'clear' }); } catch (_) {}
            }
            notify('VSRXVC: Console cleared.');
        })
    );

    let instanceSearchPanel: vscode.WebviewPanel | undefined;
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.instanceSearch', () => {
            if (instanceSearchPanel) {
                instanceSearchPanel.reveal(vscode.ViewColumn.Three, true);
                return;
            }
            instanceSearchPanel = vscode.window.createWebviewPanel(
                'vsrxInstanceSearch',
                'Instance Search',
                { viewColumn: vscode.ViewColumn.Three, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            instanceSearchPanel.webview.html = getInstanceSearchHtml();
            instanceSearchPanel.webview.onDidReceiveMessage(async (msg) => {
                if (msg.type === 'search' && msg.selector && server.hasClients()) {
                    const luaCode = generateInstanceSearchLua(msg.selector);
                    server.executeScriptFromAgent(luaCode);
                } else if (msg.type === 'search' && !server.hasClients()) {
                    vscode.window.showWarningMessage('VSRXVC: No clients connected.');
                }
            });
            instanceSearchPanel.onDidDispose(() => { instanceSearchPanel = undefined; });
        })
    );

    // Script History panel
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.scriptHistory', () => {
            if (scriptHistoryPanel) {
                scriptHistoryPanel.reveal(vscode.ViewColumn.Two, true);
                scriptHistoryPanel.webview.postMessage({ type: 'init', entries: scriptHistory });
                return;
            }
            scriptHistoryPanel = vscode.window.createWebviewPanel(
                'vsrxScriptHistory', 'VSRXVC Script History',
                { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            scriptHistoryPanel.webview.html = getScriptHistoryHtml();
            scriptHistoryPanel.webview.postMessage({ type: 'init', entries: scriptHistory });
            scriptHistoryPanel.webview.onDidReceiveMessage((msg) => {
                if (msg.type === 'rerun' && msg.script) {
                    if (!server.hasClients()) {
                        vscode.window.showWarningMessage('VSRXVC: No clients connected.');
                        return;
                    }
                    executeRawScript(msg.script);
                } else if (msg.type === 'open' && msg.script) {
                    vscode.workspace.openTextDocument({ content: msg.script, language: 'lua' })
                        .then(doc => vscode.window.showTextDocument(doc, vscode.ViewColumn.Active));
                } else if (msg.type === 'clear') {
                    scriptHistory = [];
                    extensionContext?.globalState.update('vsrxScriptHistory', []);
                }
            });
            scriptHistoryPanel.onDidDispose(() => { scriptHistoryPanel = undefined; });
        })
    );

    // Screenshot command
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.screenshot', async () => {
            await takeRobloxScreenshot(context);
        })
    );

    // GUI Interaction panel
    context.subscriptions.push(
        vscode.commands.registerCommand('vsrx.guiInteraction', () => {
            if (guiInteractionPanel) {
                guiInteractionPanel.reveal(vscode.ViewColumn.Three, true);
                return;
            }
            if (!server.hasClients()) {
                vscode.window.showWarningMessage('VSRXVC: No clients connected. Run the loader first.');
                return;
            }
            guiInteractionPanel = vscode.window.createWebviewPanel(
                'vsrxGuiInteraction', 'VSRXVC GUI Interaction',
                { viewColumn: vscode.ViewColumn.Three, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
            );
            guiInteractionPanel.webview.html = getGuiInteractionHtml();
            // Initial dump of PlayerGui tree
            const dumpLua = `
local function dumpGui(inst, depth)
    local t = {}
    local indent = string.rep("  ", depth)
    for _, v in ipairs(inst:GetChildren()) do
        local entry = indent .. v.ClassName .. "|" .. v.Name
        table.insert(t, entry)
        local children = dumpGui(v, depth + 1)
        for _, c in ipairs(children) do table.insert(t, c) end
    end
    return t
end
local pg = game:GetService("Players").LocalPlayer:FindFirstChildOfClass("PlayerGui")
if not pg then print("[VSRXVC_GUI] NO_PLAYER_GUI") return end
local lines = dumpGui(pg, 0)
print("[VSRXVC_GUI_TREE_START]")
for _, l in ipairs(lines) do print("[VSRXVC_GUI] " .. l) end
print("[VSRXVC_GUI_TREE_END]")`;
            server.executeScriptFromAgent(dumpLua);
            guiInteractionPanel.webview.onDidReceiveMessage((msg) => {
                if (msg.type === 'click' && msg.path) {
                    const lua = `
local path = "${msg.path.replace(/"/g, '\\"')}"
local parts = {}
for p in path:gmatch("[^%.]+") do parts[#parts+1] = p end
local obj = game:GetService("Players").LocalPlayer:FindFirstChildOfClass("PlayerGui")
for i = 2, #parts do obj = obj and obj:FindFirstChild(parts[i]) end
if obj then
    if obj:IsA("TextButton") or obj:IsA("ImageButton") then
        local ok, e = pcall(function() obj.MouseButton1Click:Fire() end)
        if not ok then pcall(function() obj.Activated:Fire() end) end
        print("[VSRXVC_GUI] Clicked: " .. path)
    else
        print("[VSRXVC_GUI] Not a button: " .. obj.ClassName)
    end
else print("[VSRXVC_GUI] Not found: " .. path) end`;
                    server.executeScriptFromAgent(lua);
                } else if (msg.type === 'settext' && msg.path && msg.text !== undefined) {
                    const escaped = (msg.text as string).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                    const lua = `
local path = "${msg.path.replace(/"/g, '\\"')}"
local parts = {}
for p in path:gmatch("[^%.]+") do parts[#parts+1] = p end
local obj = game:GetService("Players").LocalPlayer:FindFirstChildOfClass("PlayerGui")
for i = 2, #parts do obj = obj and obj:FindFirstChild(parts[i]) end
if obj and obj:IsA("TextBox") then
    obj.Text = "${escaped}"
    print("[VSRXVC_GUI] Set text on: " .. path)
else print("[VSRXVC_GUI] Not a TextBox or not found: " .. tostring(path)) end`;
                    server.executeScriptFromAgent(lua);
                } else if (msg.type === 'refresh') {
                    const dumpLua2 = `
local function dumpGui(inst, depth)
    local t = {}
    local indent = string.rep("  ", depth)
    for _, v in ipairs(inst:GetChildren()) do
        local entry = indent .. v.ClassName .. "|" .. v.Name
        table.insert(t, entry)
        local children = dumpGui(v, depth + 1)
        for _, c in ipairs(children) do table.insert(t, c) end
    end
    return t
end
local pg = game:GetService("Players").LocalPlayer:FindFirstChildOfClass("PlayerGui")
if not pg then print("[VSRXVC_GUI] NO_PLAYER_GUI") return end
local lines = dumpGui(pg, 0)
print("[VSRXVC_GUI_TREE_START]")
for _, l in ipairs(lines) do print("[VSRXVC_GUI] " .. l) end
print("[VSRXVC_GUI_TREE_END]")`;
                    server.executeScriptFromAgent(dumpLua2);
                }
            });
            guiInteractionPanel.onDidDispose(() => { guiInteractionPanel = undefined; });
        })
    );

    // Register Copilot / MCP language model tool (requires VS Code 1.90+)
    if ('lm' in vscode && typeof (vscode as any).lm.registerTool === 'function') {
        context.subscriptions.push(
            (vscode as any).lm.registerTool('vsrx_execute', {
                async invoke(options: any, _token: any) {
                    const script: string = options?.input?.script;
                    if (!script?.trim()) {
                        return new (vscode as any).LanguageModelToolResult([
                            new (vscode as any).LanguageModelTextPart('Error: no script provided.')
                        ]);
                    }
                    if (!server.hasClients()) {
                        return new (vscode as any).LanguageModelToolResult([
                            new (vscode as any).LanguageModelTextPart('No Roblox clients connected. Execute the loader script in your executor first.')
                        ]);
                    }
                    const count = server.executeScriptFromAgent(script);
                    return new (vscode as any).LanguageModelToolResult([
                        new (vscode as any).LanguageModelTextPart(`Script queued for execution on ${count} client(s).`)
                    ]);
                }
            })
        );
    }


    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    statusBarItem.text = `$(versions) No Clients`;
    statusBarItem.tooltip = "Click to View VSRXVC Connections";
    statusBarItem.command = 'vsrx.showClients';
    context.subscriptions.push(statusBarItem);

    runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    runButton.text = `$(play) Inject`;
    runButton.tooltip = "Run script in connected clients or copy loader";
    runButton.command = 'vsrx.runScript';
    runButton.color = new vscode.ThemeColor('testing.iconFailed');
    context.subscriptions.push(runButton);

    savedScriptsButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    savedScriptsButton.text = `$(folder-library) Save`;
    savedScriptsButton.tooltip = "VSRXVC: View and Run Saved Scripts";
    savedScriptsButton.command = 'vsrx.showSavedScripts';
    context.subscriptions.push(savedScriptsButton);

    scriptHubButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    scriptHubButton.text = `$(cloud-download) Hub`;
    scriptHubButton.tooltip = "VSRXVC: Search and Run Scripts from ScriptBlox";
    scriptHubButton.command = 'vsrx.showScriptHub';
    context.subscriptions.push(scriptHubButton);

    applyStatusBarVisibility();

    server.onLogReceived = (log) => {
        // Route GUI tree messages to GUI Interaction panel
        if (log.message.startsWith('[VSRXVC_GUI]') || log.message === '[VSRXVC_GUI_TREE_START]' || log.message === '[VSRXVC_GUI_TREE_END]') {
            if (guiInteractionPanel) {
                try { guiInteractionPanel.webview.postMessage({ type: 'guilog', line: log.message }); } catch (_) {}
            }
            return; // don't spam console with tree dumps
        }
        queueLog(log.message, log.type, log.playerName);
    };

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => {
        applyStatusBarVisibility();
    }));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('vsrx.showSaveButton') ||
            e.affectsConfiguration('vsrx.showHubButton') ||
            e.affectsConfiguration('vsrx.statusBarVisibility')) {
            applyStatusBarVisibility();
        }
        if (e.affectsConfiguration('vsrx.enableConsoleCapture')) {
            const enabled = vscode.workspace.getConfiguration('vsrx').get<boolean>('enableConsoleCapture') !== false;
            server.consoleEnabled = enabled;
            if (enabled) {
                setupConsole();
                logToConsole('VSRXVC: Console Capture Enabled.', 'system');
            } else {
                logToConsole('VSRXVC: Console Capture Disabled.', 'system');
            }
        }
        if (e.affectsConfiguration('vsrx.enableInternalUI')) {
            server.internalUIEnabled = vscode.workspace.getConfiguration('vsrx').get<boolean>('enableInternalUI') === true;
        }
        if (e.affectsConfiguration('vsrx.showUIOnLoad')) {
            server.showUIOnLoad = vscode.workspace.getConfiguration('vsrx').get<boolean>('showUIOnLoad') === true;
        }
        if (e.affectsConfiguration('vsrx.defaultSavePath')) {
            server.defaultSavePath = vscode.workspace.getConfiguration('vsrx').get<string>('defaultSavePath') || "";
        }
    }));

    setInterval(() => updateStatusBar(), 500);
}

function applyStatusBarVisibility() {
    const config = vscode.workspace.getConfiguration('vsrx');
    const visibility = config.get<string>('statusBarVisibility') ?? 'always';
    const isLuaActive = ['lua', 'luau'].includes(
        vscode.window.activeTextEditor?.document.languageId ?? ''
    );
    const shouldShow = visibility === 'always' || isLuaActive;

    if (shouldShow) {
        statusBarItem.show();
        runButton.show();
        if (config.get<boolean>('showSaveButton')) savedScriptsButton.show(); else savedScriptsButton.hide();
        if (config.get<boolean>('showHubButton')) scriptHubButton.show(); else scriptHubButton.hide();
    } else {
        statusBarItem.hide();
        runButton.hide();
        savedScriptsButton.hide();
        scriptHubButton.hide();
    }
}

function updateStatusBar() {
    if (!server) return;

    const count = server.connectedClients.size;
    if (count !== lastStatusBarCount) {
        if (count > lastStatusBarCount && lastStatusBarCount !== -1) {
            logToConsole(`VSRXVC: New client connected. Total: ${count}`, 'info');
        } else if (count < lastStatusBarCount) {
            logToConsole(`VSRXVC: Client disconnected. Total: ${count}`, 'info');
        }
        lastStatusBarCount = count;
    }

    if (count > 0) {
        noClientGuideLastAutoShowAt = 0;
        noClientGuideLastClosedAt = 0;
        const gameName = server.getGameName();
        const gameStr = gameName ? ` | ${gameName}` : '';
        statusBarItem.text = `$(versions) ${count} Client${count !== 1 ? 's' : ''}${gameStr}`;
        runButton.text = `$(play) ${server.getExecutorName()}`;
        runButton.color = new vscode.ThemeColor('testing.iconPassed');
        runButton.tooltip = 'Run script in connected clients';
    } else {
        const noClientGuideConfig = getNoClientGuideConfig();
        const now = Date.now();
        const canRepeatByAutoShowWindow = now - noClientGuideLastAutoShowAt >= noClientGuideConfig.repeatDelayMs;
        const canRepeatAfterClose = now - noClientGuideLastClosedAt >= noClientGuideConfig.repeatDelayMs;

        statusBarItem.text = `$(versions) No Clients`;
        runButton.text = `$(play) Inject`;
        runButton.color = new vscode.ThemeColor('testing.iconFailed');

        const noClientTooltip = new vscode.MarkdownString('**No Roblox clients detected**\n\nClick **Inject** to open setup guide.');
        noClientTooltip.isTrusted = false;
        runButton.tooltip = noClientTooltip;

        if (
            noClientGuideConfig.autoShow &&
            !noClientGuidePanel &&
            canRepeatByAutoShowWindow &&
            canRepeatAfterClose
        ) {
            void showNoClientGuide(true, noClientGuideConfig.autoCopyOnOpen);
        }
    }
}

function getNoClientGuideConfig() {
    const config = vscode.workspace.getConfiguration('vsrx');
    const repeatSecondsRaw = config.get<number>('noClientGuideRepeatSeconds', 120);
    const repeatSeconds = Number.isFinite(repeatSecondsRaw) ? Math.max(0, Math.floor(repeatSecondsRaw)) : 120;

    return {
        autoShow: config.get<boolean>('noClientGuideAutoShow', true) !== false,
        autoCopyOnOpen: config.get<boolean>('noClientGuideAutoCopyOnOpen', true) !== false,
        repeatDelayMs: repeatSeconds * 1000
    };
}

async function showNoClientGuide(autoOpened: boolean, copyLoaderOnOpen: boolean) {
        if (autoOpened) {
            noClientGuideLastAutoShowAt = Date.now();
        }

        const loader = server.getLoaderScript();

        if (copyLoaderOnOpen) {
                await vscode.env.clipboard.writeText(loader);
                notify('VSRXVC: Auto-detecting Loader script copied! Execute this in your emulator or executor.');
        }

        const panelTitle = autoOpened ? 'VSRX Inject Setup' : 'VSRX Inject Guide';

        if (noClientGuidePanel) {
                noClientGuidePanel.title = panelTitle;
                noClientGuidePanel.webview.html = getNoClientGuideHtml(loader, autoOpened, copyLoaderOnOpen);
                noClientGuidePanel.reveal(vscode.ViewColumn.Beside, true);
                return;
        }

        noClientGuidePanel = vscode.window.createWebviewPanel(
                'vsrxNoClientGuide',
                panelTitle,
                { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
                { enableScripts: true, retainContextWhenHidden: true }
        );

        noClientGuidePanel.webview.html = getNoClientGuideHtml(loader, autoOpened, copyLoaderOnOpen);

        noClientGuidePanel.webview.onDidReceiveMessage(async (msg: { type?: string }) => {
                if (msg.type === 'copy-loader') {
                        const latest = server.getLoaderScript();
                        await vscode.env.clipboard.writeText(latest);
                        notify('VSRXVC: Loader script copied to clipboard.');
                        if (noClientGuidePanel) {
                                noClientGuidePanel.webview.postMessage({ type: 'copied' });
                        }
                }

            if (msg.type === 'open-console') {
                setupConsole();
            }

            if (msg.type === 'open-clients') {
                await showClientsMenu();
            }

            if (msg.type === 'open-settings') {
                await vscode.commands.executeCommand('workbench.action.openSettings', 'vsrx');
            }

                if (msg.type === 'close') {
                        noClientGuidePanel?.dispose();
                }
        });

        noClientGuidePanel.onDidDispose(() => {
            noClientGuideLastClosedAt = Date.now();
            noClientGuidePanel = undefined;
        });
}

function escapeHtml(text: string): string {
        return text
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
}

function getNoClientGuideHtml(loaderScript: string, autoOpened: boolean, copiedOnOpen: boolean): string {
        const escapedScript = escapeHtml(loaderScript);
        const badge = autoOpened ? 'Auto opened: no active client' : 'Manual open from Inject';
        const copiedNote = copiedOnOpen
                ? '<p class="copy-note">Loader script was copied automatically.</p>'
                : '<p class="copy-note">Use the Copy button below to place the script in your clipboard.</p>';

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
        :root {
            --bg-a: #040506;
            --bg-b: #0a0b0d;
            --surface: rgba(11, 13, 17, 0.97);
            --surface-2: rgba(14, 16, 22, 0.97);
            --text-main: #f3f5ff;
            --text-muted: #adb6c9;
            --accent: #5f89ff;
            --accent-2: #79b0ff;
            --border: rgba(128, 150, 188, 0.28);
            --shadow: 0 14px 44px rgba(0, 0, 0, 0.62);
        }

        * { box-sizing: border-box; }

        body {
            margin: 0;
            min-height: 100vh;
            color: var(--text-main);
            background:
                radial-gradient(980px 420px at 4% -14%, rgba(95, 137, 255, 0.16), transparent 60%),
                radial-gradient(920px 420px at 100% 0%, rgba(121, 176, 255, 0.08), transparent 56%),
                linear-gradient(145deg, var(--bg-a), var(--bg-b));
            font-family: 'Segoe UI Variable', 'Segoe UI', Tahoma, sans-serif;
            padding: 20px;
            animation: fadeIn 220ms ease;
        }

        .card {
            max-width: 870px;
            margin: 0 auto;
            transform: translateX(26px);
            border: 1px solid var(--border);
            border-radius: 18px;
            background: linear-gradient(180deg, var(--surface), var(--surface-2));
            box-shadow: var(--shadow);
            overflow: hidden;
        }

        .hero {
            padding: 18px 20px;
            border-bottom: 1px solid var(--border);
            display: grid;
            gap: 8px;
            background: linear-gradient(90deg, rgba(95, 137, 255, 0.14), rgba(121, 176, 255, 0.06));
        }

        .badge {
            width: fit-content;
            font-size: 12px;
            color: #d8e6ff;
            letter-spacing: 0.02em;
            background: rgba(95, 137, 255, 0.16);
            border: 1px solid rgba(121, 176, 255, 0.46);
            padding: 4px 8px;
            border-radius: 999px;
        }

        h1 {
            margin: 0;
            font-size: 24px;
            font-weight: 700;
        }

        .sub {
            margin: 0;
            color: var(--text-muted);
            line-height: 1.55;
            font-size: 14px;
        }

        .grid {
            display: grid;
            gap: 16px;
            padding: 18px;
            grid-template-columns: 1fr 1fr;
        }

        .panel {
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 14px;
            background: rgba(10, 14, 22, 0.45);
        }

        .panel h2 {
            margin: 0 0 10px;
            font-size: 14px;
            letter-spacing: 0.01em;
            color: #d7e4ff;
        }

        ol {
            margin: 0;
            padding-left: 18px;
            color: var(--text-muted);
            line-height: 1.55;
            font-size: 13px;
        }

        .actions {
            display: flex;
            gap: 10px;
            margin-top: 12px;
            flex-wrap: wrap;
        }

        .copy-note {
            margin: 8px 0 0;
            color: #9fb8ef;
            font-size: 12px;
        }

        .quick-actions {
            margin-top: 10px;
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
        }

        .script-wrap {
            margin: 0 18px 18px;
            border: 1px solid var(--border);
            border-radius: 12px;
            overflow: hidden;
            background: #06070a;
        }

        .script-head {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            background: rgba(255, 255, 255, 0.03);
            font-size: 12px;
            color: #cbdcff;
        }

        pre {
            margin: 0;
            padding: 12px;
            overflow: auto;
            max-height: 270px;
            color: #e2ecff;
            font-size: 12px;
            line-height: 1.5;
            font-family: Consolas, 'Cascadia Mono', 'Courier New', monospace;
        }

        .btn {
            padding: 9px 13px;
            cursor: pointer;
            font-size: 13px;
            font-weight: 600;
            transition: box-shadow 120ms ease, transform 120ms ease, border-color 120ms ease;
            border-radius: 999px;
            border: 1px solid rgba(122, 150, 204, 0.52);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 rgba(95, 137, 255, 0);
        }

        .btn:hover {
            transform: translateY(-1px);
            box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.16), 0 0 12px rgba(95, 137, 255, 0.28);
        }

        .btn-primary {
            color: #ffffff;
            background: linear-gradient(135deg, #496fd8, #5f89ff 58%, #78adff);
            border-color: rgba(155, 183, 243, 0.78);
            text-shadow: 0 1px 0 rgba(0, 0, 0, 0.22);
        }

        .btn-secondary {
            color: #d2e0ff;
            background: linear-gradient(135deg, rgba(67, 89, 132, 0.42), rgba(96, 126, 188, 0.16));
            border-color: rgba(128, 150, 188, 0.45);
        }

        @media (max-width: 840px) {
            body { padding: 12px; }
            .card { transform: none; }
            .grid { grid-template-columns: 1fr; padding: 12px; }
            .script-wrap { margin: 0 12px 12px; }
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(8px); }
            to { opacity: 1; transform: translateY(0); }
        }
    </style>
</head>
<body>
    <div class="card">
        <section class="hero">
            <div class="badge">${badge}</div>
            <h1>No clients are connected right now</h1>
            <p class="sub">Inject button is waiting for an executor client to connect. Use the loader script below inside Roblox executor, then return to VS Code and run your Lua file again.</p>
        </section>

        <section class="grid">
            <div class="panel">
                <h2>How it works</h2>
                <ol>
                    <li>VSRX starts a local bridge server on your PC.</li>
                    <li>The loader script connects your executor to that bridge.</li>
                    <li>After connection, Inject becomes your executor name and scripts run instantly.</li>
                </ol>
            </div>

            <div class="panel">
                <h2>What to do now</h2>
                <ol>
                    <li>Copy loader script.</li>
                    <li>Paste and execute it in your Roblox executor.</li>
                    <li>Wait until status bar shows at least 1 client.</li>
                </ol>
                <div class="actions">
                    <button class="btn btn-primary" id="copyBtn">Copy Loader</button>
                    <button class="btn btn-secondary" id="closeBtn">Close</button>
                </div>
                <div class="quick-actions">
                    <button class="btn btn-secondary" id="consoleBtn">Open Console</button>
                    <button class="btn btn-secondary" id="clientsBtn">Clients</button>
                    <button class="btn btn-secondary" id="settingsBtn">VSRX Settings</button>
                </div>
                ${copiedNote}
            </div>
        </section>

        <section class="script-wrap">
            <div class="script-head">
                <span>Loader Script</span>
                <span id="statusText">Ready</span>
            </div>
            <pre>${escapedScript}</pre>
        </section>
    </div>

    <script>
        const vscodeApi = acquireVsCodeApi();
        const statusText = document.getElementById('statusText');
        const copyBtn = document.getElementById('copyBtn');
        const closeBtn = document.getElementById('closeBtn');
        const consoleBtn = document.getElementById('consoleBtn');
        const clientsBtn = document.getElementById('clientsBtn');
        const settingsBtn = document.getElementById('settingsBtn');

        copyBtn.addEventListener('click', () => {
            statusText.textContent = 'Copying...';
            vscodeApi.postMessage({ type: 'copy-loader' });
        });

        closeBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'close' });
        });

        consoleBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'open-console' });
        });

        clientsBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'open-clients' });
        });

        settingsBtn.addEventListener('click', () => {
            vscodeApi.postMessage({ type: 'open-settings' });
        });

        window.addEventListener('message', (event) => {
            if (event.data && event.data.type === 'copied') {
                statusText.textContent = 'Copied to clipboard';
            }
        });
    <\/script>
</body>
</html>`;
}

async function showClientsMenu() {
    if (server.connectedClients.size === 0) {
        vscode.window.showInformationMessage("VSRXVC: No active clients connected. Run the Loader script first.");
        return;
    }

    const items: vscode.QuickPickItem[] = [];

    for (const [id, client] of server.connectedClients.entries()) {
        const stateIcon = client.executionEnabled ? '$(check)' : '$(circle-slash)';
        const stateText = client.executionEnabled ? 'Enabled' : 'Disabled';

        items.push({
            label: `${stateIcon} ${client.name}`,
            description: `Executor: ${client.executorName || 'Unknown'}`,
            detail: `User ID: ${client.userId || 'N/A'} • Game: ${client.gameName || client.placeId || 'Unknown'} - Click to Toggle (${stateText})`,
            // @ts-ignore
            clientId: id,
            clientEnabled: client.executionEnabled
        });
    }

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a client to Toggle Execution (ON/OFF)',
        matchOnDescription: true,
        matchOnDetail: true
    });

    if (selected) {
        // @ts-ignore
        const clientId = selected.clientId;
        // @ts-ignore
        const currentEnabled = selected.clientEnabled;
        server.setClientExecution(clientId, !currentEnabled);
        notify(`VSRXVC: Client '${selected.label.split(' ')[1]}' execution is now ${!currentEnabled ? 'ON' : 'OFF'}`);
    }
}

function runScript() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('VSRXVC: No active script to run.');
        return;
    }
    executeRawScript(editor.document.getText());
}

function executeRawScript(script: string) {
    if (!script.trim()) {
        vscode.window.showErrorMessage('VSRXVC: Script is empty.');
        return;
    }

    lastExecutedScript = script;
    const entry = {
        ts: new Date().toLocaleTimeString('en-GB', { hour12: false }),
        preview: script.trim().split('\n')[0].slice(0, 80),
        script
    };
    scriptHistory.unshift(entry);
    if (scriptHistory.length > SCRIPT_HISTORY_MAX) { scriptHistory.pop(); }
    extensionContext?.globalState.update('vsrxScriptHistory', scriptHistory);
    if (scriptHistoryPanel) {
        try { scriptHistoryPanel.webview.postMessage({ type: 'add', entry }); } catch (_) {}
    }
    const count = server.executeScriptFromAgent(script);
    notify(`VSRXVC: Script queued for ${count} client(s).`);
}

async function saveScript() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('VSRXVC: No active script to save.');
        return;
    }

    const script = editor.document.getText();
    if (!script.trim()) {
        vscode.window.showWarningMessage('VSRXVC: Script is empty, nothing to save.');
        return;
    }

    const config = vscode.workspace.getConfiguration('vsrx');
    const defaultPath = config.get<string>('defaultSavePath');

    if (defaultPath && defaultPath.trim() !== "") {
        try {
            let finalPath = defaultPath;
            if (!path.extname(finalPath)) {
                const fileName = await vscode.window.showInputBox({
                    prompt: 'Enter script name',
                    value: `vsrx_script_${Date.now()}.lua`
                });
                if (!fileName) return;

                finalPath = path.join(finalPath, fileName.endsWith('.lua') || fileName.endsWith('.luau') ? fileName : `${fileName}.lua`);
            }

            fs.writeFileSync(finalPath, script, 'utf8');
            notify(`VSRXVC: Script saved to ${finalPath}`);
            return;
        } catch (error: any) {
            vscode.window.showErrorMessage(`VSRXVC: Failed to save to default path. Error: ${error.message}`);
        }
    }

    const uri = await vscode.window.showSaveDialog({
        filters: {
            'Lua Scripts': ['lua', 'luau'],
            'All Files': ['*']
        },
        title: 'Save VSRX Script'
    });

    if (uri) {
        try {
            const contentBytes = Buffer.from(script, 'utf8');
            await vscode.workspace.fs.writeFile(uri, contentBytes);
            notify('VSRXVC: Script saved successfully.');
        } catch (error: any) {
            vscode.window.showErrorMessage(`VSRXVC: Could not save file. Error: ${error.message}`);
        }
    }
}

async function showSavedScripts() {
    const config = vscode.workspace.getConfiguration('vsrx');
    const defaultPath = config.get<string>('defaultSavePath');

    if (!defaultPath || defaultPath.trim() === "") {
        const setNow = await vscode.window.showWarningMessage('VSRXVC: Default Save Path is not set. Would you like to set it now?', 'Set Settings', 'Cancel');
        if (setNow === 'Set Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'vsrx.defaultSavePath');
        }
        return;
    }

    if (!fs.existsSync(defaultPath)) {
        vscode.window.showErrorMessage(`VSRXVC: Directory does not exist: ${defaultPath}`);
        return;
    }

    try {
        const files = fs.readdirSync(defaultPath);
        const items: vscode.QuickPickItem[] = files.map(file => {
            const fullPath = path.join(defaultPath, file);
            const isDir = fs.statSync(fullPath).isDirectory();
            return {
                label: isDir ? `$(folder) ${file}` : `$(file-code) ${file}`,
                description: isDir ? 'Folder - Click to open' : 'Lua Script - Click to execute',
                // @ts-ignore
                fullPath,
                isDir
            };
        });

        if (items.length === 0) {
            notify('VSRXVC: No scripts found in the save directory.');
            return;
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select a script to run or folder to open'
        });

        if (selected) {
            // @ts-ignore
            if (selected.isDir) {
                vscode.env.openExternal(vscode.Uri.file((selected as any).fullPath));
            } else {
                const scriptContent = fs.readFileSync((selected as any).fullPath, 'utf8');
                executeRawScript(scriptContent);
            }
        }
    } catch (e: any) {
        vscode.window.showErrorMessage(`VSRXVC: Failed to read directory. Error: ${e.message}`);
    }
}

async function showScriptHub(query: string = '', page: number = 1) {
    let url = `https://scriptblox.com/api/script/fetch?page=${page}`;
    if (query && query.trim() !== '') {
        url = `https://scriptblox.com/api/script/search?q=${encodeURIComponent(query)}&page=${page}`;
    }

    notify(`VSRXVC: Fetching scripts from ScriptBlox (Page ${page})...`);

    https.get(url, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', async () => {
            if (res.statusCode === 200) {
                try {
                    const parsed = JSON.parse(data);
                    if (!parsed.result || !parsed.result.scripts || parsed.result.scripts.length === 0) {
                        vscode.window.showInformationMessage('VSRXVC: No scripts found for this search.');
                        const searchAgain = await vscode.window.showInputBox({ prompt: 'Search ScriptBlox (Leave empty for trending)', placeHolder: 'e.g. Blox Fruits' });
                        if (searchAgain !== undefined) showScriptHub(searchAgain, 1);
                        return;
                    }

                    const items: vscode.QuickPickItem[] = [];

                    items.push({
                        label: `$(search) Search ScriptBlox...`,
                        description: `Current Query: ${query || 'Trending'}`,
                        // @ts-ignore
                        isAction: 'search'
                    });

                    for (const script of parsed.result.scripts) {
                        items.push({
                            label: `$(code) ${script.title}`,
                            description: script.game && script.game.name ? `Game: ${script.game.name}` : `Universal`,
                            detail: `Views: ${script.views} | Verified: ${script.verified ? 'Yes' : 'No'}`,
                            // @ts-ignore
                            scriptCode: script.script,
                            isAction: 'run'
                        });
                    }

                    if (page > 1) {
                        items.push({
                            label: `$(arrow-left) Previous Page`,
                            description: `Go to Page ${page - 1}`,
                            // @ts-ignore
                            isAction: 'prev'
                        });
                    }

                    if (parsed.result.totalPages && page < parsed.result.totalPages) {
                        items.push({
                            label: `$(arrow-right) Next Page`,
                            description: `Go to Page ${page + 1}`,
                            // @ts-ignore
                            isAction: 'next'
                        });
                    }

                    const selected = await vscode.window.showQuickPick(items, {
                        placeHolder: `ScriptBlox Hub - Page ${page}/${parsed.result.totalPages || 1}`,
                        matchOnDescription: true,
                        matchOnDetail: true
                    });

                    if (selected) {
                        // @ts-ignore
                        const action = selected.isAction;
                        if (action === 'search') {
                            const newQuery = await vscode.window.showInputBox({
                                prompt: 'Search ScriptBlox (Leave empty for trending)',
                                placeHolder: 'e.g. Blox Fruits',
                                value: query
                            });
                            if (newQuery !== undefined) {
                                showScriptHub(newQuery, 1);
                            }
                        } else if (action === 'next') {
                            showScriptHub(query, page + 1);
                        } else if (action === 'prev') {
                            showScriptHub(query, page - 1);
                        } else if (action === 'run') {
                            // @ts-ignore
                            executeRawScript(selected.scriptCode);
                        }
                    }

                } catch (e) {
                    vscode.window.showErrorMessage('VSRXVC: Failed to parse ScriptBlox data.');
                }
            } else {
                vscode.window.showErrorMessage(`VSRXVC: ScriptBlox API Error (Status: ${res.statusCode})`);
            }
        });
    }).on('error', (e) => {
        vscode.window.showErrorMessage(`VSRXVC: Network Error - ${e.message}`);
    });
}



function getConsoleHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
    --bg-a: #040506;
    --bg-b: #0a0b0d;
    --surface: rgba(11, 13, 17, 0.97);
    --text-main: #f3f5ff;
    --text-muted: #a8b5d2;
    --accent: #5f89ff;
    --accent-2: #79b0ff;
    --border: rgba(128, 150, 188, 0.28);
}
body {
    background:
        radial-gradient(980px 320px at 0% -18%, rgba(95, 137, 255, 0.16), transparent 62%),
        radial-gradient(800px 280px at 100% -12%, rgba(121, 176, 255, 0.09), transparent 56%),
        linear-gradient(180deg, var(--bg-a), var(--bg-b));
    color: var(--text-main);
    font-family: Consolas, 'Cascadia Mono', 'Courier New', monospace;
    font-size: 13px;
    height: 100vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
}
.toolbar {
    background: var(--surface);
    padding: 6px 8px;
    display: flex;
    gap: 6px;
    align-items: center;
    flex-wrap: wrap;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
}
.toolbar-break {
    flex-basis: 100%;
    height: 0;
}
.btn {
    background: linear-gradient(140deg, rgba(95, 137, 255, 0.2), rgba(121, 176, 255, 0.1));
    color: #dce9ff;
    border: 1px solid rgba(122, 150, 204, 0.52);
    padding: 2px 10px;
    cursor: pointer;
    border-radius: 999px;
    font-size: 12px;
    font-family: inherit;
    transition: box-shadow 120ms ease, transform 120ms ease, border-color 120ms ease;
}
.btn:hover {
    color: #fff;
    border-color: rgba(137, 181, 255, 0.84);
    box-shadow: 0 0 12px rgba(95, 137, 255, 0.32);
    transform: translateY(-1px);
}
.btn.active {
    background: linear-gradient(135deg, #5f89ff, #79b0ff 60%, #98c3ff);
    border-color: rgba(170, 197, 255, 0.94);
    color: #fff;
    text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);
}
#search {
    background: rgba(8, 11, 16, 0.95);
    color: #eef4ff;
    border: 1px solid rgba(121, 156, 226, 0.36);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 12px;
    font-family: inherit;
    min-width: 220px;
    flex: 1;
    outline: none;
}
#search:focus {
    border-color: rgba(137, 181, 255, 0.84);
    box-shadow: 0 0 0 1px rgba(95, 137, 255, 0.4);
}
#log { flex: 1; overflow-y: auto; padding: 2px 0; }
.row {
    padding: 2px 8px;
    display: flex;
    gap: 5px;
    align-items: baseline;
    line-height: 1.5;
    border-left: 2px solid transparent;
}
.row:hover {
    background: rgba(255, 255, 255, 0.03);
        border-left-color: rgba(121, 176, 255, 0.48);
}
.ts { color: #7f8397; flex-shrink: 0; font-size: 11px; }
.sep { color: #3e4357; }
.lbl { flex-shrink: 0; font-size: 11px; min-width: 42px; font-weight: bold; }
.lbl-info { color: #6da8ff; }
.lbl-warn { color: #ffc27e; }
.lbl-error { color: #ff829d; }
.lbl-system { color: #9ab9ff; }
.player { color: #9a9fb8; flex-shrink: 0; }
.msg-info { color: #e7e9f8; }
.msg-warn { color: #ffc27e; }
.msg-error { color: #ff8aa2; }
.msg-system { color: #b8d0ff; }
.fix-btn {
    margin-left: 6px;
    background: rgba(95, 137, 255, 0.13);
    color: #9ab9ff;
    border: 1px solid rgba(122, 150, 204, 0.38);
    padding: 1px 7px;
    border-radius: 999px;
    font-size: 11px;
    font-family: inherit;
    cursor: pointer;
    flex-shrink: 0;
    transition: background 120ms, color 120ms;
}
.fix-btn:hover { background: rgba(95,137,255,0.32); color: #fff; }
.count { color: #8b8fa3; font-size: 11px; }
</style></head><body>
<div class="toolbar">
  <button class="btn active" id="f-all"   onclick="setFilter('all')">All</button>
  <button class="btn"        id="f-info"  onclick="setFilter('info')">Info</button>
  <button class="btn"        id="f-warn"  onclick="setFilter('warn')">Warn</button>
  <button class="btn"        id="f-error" onclick="setFilter('error')">Error</button>
    <div class="toolbar-break"></div>
  <input id="search" type="text" placeholder="Search..." oninput="applyFilters()" />
    <button class="btn" onclick="saveLogs()">Save</button>
  <button class="btn" onclick="clearLogs()">Clear</button>
</div>
<div id="log"></div>
<script>
  let filter = 'all';
  function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function makeRow(e) {
    const div = document.createElement('div');
    div.className = 'row';
    div.dataset.type = e.typeLabel;
    div.dataset.text = ((e.player || '') + ' ' + (e.message || '')).toLowerCase();
    const fixBtn = e.typeLabel === 'error' ? '<button class="fix-btn" data-msg="' + esc(e.message) + '">✦ Fix</button>' : '';
    div.innerHTML =
      '<span class="ts">' + esc(e.ts) + '</span>' +
      '<span class="sep"> | </span>' +
      '<span class="lbl lbl-' + e.typeLabel + '">' + e.typeLabel.toUpperCase() + '</span>' +
      '<span class="sep"> | </span>' +
      (e.player ? '<span class="player">' + esc(e.player) + '</span><span class="sep"> | </span>' : '') +
      '<span class="msg-' + e.typeLabel + '">' + esc(e.message) + '</span>' +
      (e.count > 1 ? '<span class="count"> (x' + e.count + ')</span>' : '') +
      fixBtn;
    return div;
  }
  function applyFilter(row) {
    const search = document.getElementById('search').value.toLowerCase();
    const ok = (filter === 'all' || row.dataset.type === filter) && (!search || row.dataset.text.includes(search));
    row.style.display = ok ? 'flex' : 'none';
  }
  function applyFilters() { document.querySelectorAll('.row').forEach(applyFilter); }
  function setFilter(f) {
    filter = f;
    document.querySelectorAll('.btn[id^="f-"]').forEach(b => b.classList.remove('active'));
    document.getElementById('f-' + f).classList.add('active');
    applyFilters();
  }
  function addEntry(e) {
    const log = document.getElementById('log');
    const row = makeRow(e);
    log.appendChild(row);
    applyFilter(row);
    if (row.style.display !== 'none') row.scrollIntoView({ block: 'end' });
  }
  const vscodeApi = acquireVsCodeApi();
  function clearLogs() {
    document.getElementById('log').innerHTML = '';
    vscodeApi.postMessage({ type: 'clear' });
  }
  function saveLogs() { vscodeApi.postMessage({ type: 'savelog' }); }
  document.getElementById('log').addEventListener('click', function(ev) {
    const btn = ev.target.closest('.fix-btn');
    if (btn) vscodeApi.postMessage({ type: 'fix-error', message: btn.dataset.msg });
  });
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'log')   addEntry(m.entry);
    if (m.type === 'init')  m.entries.forEach(addEntry);
    if (m.type === 'clear') document.getElementById('log').innerHTML = '';
  });
<\/script></body></html>`;
}

function setupConsole() {
    if (consolePanel) {
        consolePanel.reveal(vscode.ViewColumn.Two, true);
        return;
    }
    consolePanel = vscode.window.createWebviewPanel(
        'vsrxConsole',
        'VSRXVC Console',
        { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true }
    );
    consolePanel.webview.html = getConsoleHtml();
    consolePanel.webview.postMessage({ type: 'init', entries: logHistory });
    consolePanel.webview.onDidReceiveMessage(async (msg) => {
        if (msg.type === 'clear') {
            logHistory = [];
        } else if (msg.type === 'savelog') {
            const uri = await vscode.window.showSaveDialog({
                filters: { 'Log Files': ['log'], 'Text Files': ['txt'] },
                title: 'Save VSRX Console Log'
            });
            if (uri) {
                const lines = logHistory.map(e =>
                    `[${e.ts}] [${e.typeLabel.toUpperCase()}] ${e.player ? e.player + ' | ' : ''}${e.message}${e.count > 1 ? ` (x${e.count})` : ''}`
                ).join('\n');
                await vscode.workspace.fs.writeFile(uri, Buffer.from(lines, 'utf8'));
                notify('VSRXVC: Log saved.');
            }
        } else if (msg.type === 'fix-error') {
            void fixScriptWithAI(msg.message as string);
        }
    });
    consolePanel.onDidDispose(() => { consolePanel = undefined; });
    logToConsole('VSRXVC Console started.', 'system');
}

function pushLog(ts: string, typeLabel: string, player: string, message: string, count: number) {
    const entry = { ts, typeLabel, player, message, count };
    logHistory.push(entry);
    if (logHistory.length > LOG_HISTORY_MAX) { logHistory.shift(); }
    if (consolePanel) {
        try { consolePanel.webview.postMessage({ type: 'log', entry }); } catch (_) {}
    }
}

function queueLog(message: string, type: number, playerName: string) {
    if (logBuffer && logBuffer.message === message && logBuffer.type === type && logBuffer.playerName === playerName) {
        logBuffer.count++;
        if (logBufferTimeout) { clearTimeout(logBufferTimeout); }
        logBufferTimeout = setTimeout(() => flushLogBuffer(), 100);
    } else {
        if (logBuffer) { flushLogBuffer(); }
        logBuffer = { message, type, playerName, count: 1 };
        logBufferTimeout = setTimeout(() => flushLogBuffer(), 100);
    }
}

function flushLogBuffer() {
    if (!logBuffer) { return; }
    if (logBufferTimeout) { clearTimeout(logBufferTimeout); logBufferTimeout = null; }
    let typeLabel = 'info';
    if (logBuffer.type === 2) { typeLabel = 'warn'; }
    else if (logBuffer.type === 3) { typeLabel = 'error'; }
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    pushLog(ts, typeLabel, logBuffer.playerName, logBuffer.message, logBuffer.count);
    logBuffer = null;
}

function logToConsole(message: string, type: string = 'info') {
    const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
    pushLog(ts, type, 'system', message, 1);
}

async function fixScriptWithAI(errorMessage: string) {
    if (!lastExecutedScript.trim()) {
        vscode.window.showWarningMessage('VSRXVC: No script has been executed yet — nothing to fix.');
        return;
    }
    const lm = (vscode as any).lm;
    if (!lm || typeof lm.selectChatModels !== 'function') {
        vscode.window.showErrorMessage('VSRXVC: Language model API not available. Make sure GitHub Copilot is active.');
        return;
    }
    const models = await lm.selectChatModels({ family: 'gpt-4o' });
    if (!models || !models.length) {
        vscode.window.showErrorMessage('VSRXVC: No AI model available. Make sure GitHub Copilot is active.');
        return;
    }
    const model = models[0];
    const prompt = `You are a Roblox Luau expert. The following script produced a runtime error. Fix ONLY the bug described by the error. Return ONLY the corrected Lua code — no explanation, no markdown fences.

Error: ${errorMessage}

Script:
${lastExecutedScript}`;
    try {
        const LMChatMessage = (vscode as any).LanguageModelChatMessage;
        const messages = [LMChatMessage.User(prompt)];
        const cts = new vscode.CancellationTokenSource();
        const response = await model.sendRequest(messages, {}, cts.token);
        let fixed = '';
        for await (const chunk of response.text) { fixed += chunk; }
        fixed = fixed.replace(/^```(?:lua|luau)?\n?/i, '').replace(/\n?```$/, '').trim();
        if (!fixed) { vscode.window.showErrorMessage('VSRXVC: AI returned an empty response.'); return; }
        const choice = await vscode.window.showInformationMessage(
            'VSRXVC: AI produced a fix. What would you like to do?',
            'View Fix', 'Re-run Fixed', 'Cancel'
        );
        if (choice === 'View Fix') {
            const doc = await vscode.workspace.openTextDocument({ content: fixed, language: 'lua' });
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        } else if (choice === 'Re-run Fixed') {
            executeRawScript(fixed);
        }
    } catch (e: any) {
        vscode.window.showErrorMessage(`VSRXVC: AI fix failed — ${e.message}`);
    }
}

function getScriptHistoryHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --bg: #050608; --surface: rgba(12,14,20,0.97); --border: rgba(120,144,190,0.22); --accent: #5f89ff; --text: #dde4f8; --muted: #8a94b4; }
body { background: var(--bg); color: var(--text); font-family: Consolas,'Cascadia Mono',monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; }
.btn { background: rgba(95,137,255,0.14); color: #cfe0ff; border: 1px solid rgba(122,150,204,0.44); padding: 2px 11px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: inherit; transition: background 120ms; }
.btn:hover { background: rgba(95,137,255,0.3); color: #fff; }
.list { flex: 1; overflow-y: auto; padding: 6px 0; }
.item { border-bottom: 1px solid rgba(120,144,190,0.12); padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.item:hover { background: rgba(255,255,255,0.03); }
.item-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.ts { color: var(--muted); font-size: 11px; flex-shrink: 0; }
.preview { color: #b0c4ee; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.actions { display: flex; gap: 5px; }
.empty { padding: 24px; color: var(--muted); text-align: center; }
</style></head><body>
<div class="toolbar">
    <span style="color:var(--muted);font-size:12px;flex:1">Script History</span>
    <button class="btn" onclick="clearAll()">Clear</button>
</div>
<div class="list" id="list"><div class="empty" id="empty">No scripts run yet.</div></div>
<script>
    const vscodeApi = acquireVsCodeApi();
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function makeItem(e, idx) {
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = '<div class="item-head"><span class="ts">' + esc(e.ts) + '</span><span class="preview">' + esc(e.preview) + '</span><div class="actions"><button class="btn" data-idx="' + idx + '" data-action="rerun">▶ Re-run</button><button class="btn" data-idx="' + idx + '" data-action="open">Open</button></div></div>';
        return div;
    }
    let entries = [];
    function render() {
        const list = document.getElementById('list');
        const empty = document.getElementById('empty');
        list.querySelectorAll('.item').forEach(e => e.remove());
        if (!entries.length) { empty.style.display = ''; return; }
        empty.style.display = 'none';
        entries.forEach((e, i) => list.appendChild(makeItem(e, i)));
    }
    list.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const idx = +btn.dataset.idx;
        const e = entries[idx];
        if (!e) return;
        vscodeApi.postMessage({ type: btn.dataset.action, script: e.script });
    });
    function clearAll() {
        entries = [];
        render();
        vscodeApi.postMessage({ type: 'clear' });
    }
    window.addEventListener('message', ev => {
        const m = ev.data;
        if (m.type === 'init') { entries = m.entries || []; render(); }
        if (m.type === 'add') { entries.unshift(m.entry); render(); }
    });
<\/script></body></html>`;
}

async function takeRobloxScreenshot(context: vscode.ExtensionContext) {
        const tmpPng = path.join(require('os').tmpdir(), 'vsrxvc_screenshot.png');
        const ps = `
Add-Type -AssemblyName System.Drawing
$proc = Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $proc) { Write-Error "Roblox not running"; exit 1 }
$hwnd = $proc.MainWindowHandle
Add-Type @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class WinAPI {
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
        public struct RECT { public int Left,Top,Right,Bottom; }
}
'@
$rect = New-Object WinAPI+RECT
[WinAPI]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { Write-Error "Bad window size"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[WinAPI]::PrintWindow($hwnd, $hdc, 0x2) | Out-Null
$g.ReleaseHdc($hdc); $g.Dispose()
$bmp.Save('${tmpPng.replace(/\\/g, '\\\\')}')
$bmp.Dispose()
Write-Host "OK"
`;
        const psFile = path.join(require('os').tmpdir(), 'vsrxvc_ss.ps1');
        fs.writeFileSync(psFile, ps, 'utf8');
        try {
                await new Promise<void>((resolve, reject) => {
                        require('child_process').exec(
                                `powershell -ExecutionPolicy Bypass -NonInteractive -File "${psFile}"`,
                                (err: Error | null, stdout: string, stderr: string) => {
                                        if (err) { reject(new Error(stderr || err.message)); } else { resolve(); }
                                }
                        );
                });
                if (!fs.existsSync(tmpPng)) {
                        vscode.window.showErrorMessage('VSRXVC: Screenshot file not created.');
                        return;
                }
                const uri = vscode.Uri.file(tmpPng);
                await vscode.commands.executeCommand('vscode.open', uri);
                notify('VSRXVC: Screenshot captured.');
        } catch (e: any) {
                vscode.window.showErrorMessage(`VSRXVC: Screenshot failed — ${e.message}`);
        }
}

function getGuiInteractionHtml(): string {
        return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root { --bg: #050608; --surface: rgba(12,14,20,0.97); --border: rgba(120,144,190,0.22); --accent: #5f89ff; --text: #dde4f8; --muted: #8a94b4; }
body { background: var(--bg); color: var(--text); font-family: Consolas,'Cascadia Mono',monospace; font-size: 13px; height: 100vh; display: flex; flex-direction: column; }
.toolbar { display: flex; gap: 6px; padding: 7px 10px; border-bottom: 1px solid var(--border); background: var(--surface); flex-shrink: 0; align-items: center; }
.btn { background: rgba(95,137,255,0.14); color: #cfe0ff; border: 1px solid rgba(122,150,204,0.44); padding: 2px 11px; border-radius: 999px; font-size: 12px; cursor: pointer; font-family: inherit; transition: background 120ms; }
.btn:hover { background: rgba(95,137,255,0.3); color: #fff; }
.tree { flex: 1; overflow-y: auto; padding: 6px 0; }
.node { padding: 3px 12px; cursor: pointer; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.node:hover { background: rgba(255,255,255,0.04); }
.cls { color: #7ab3ff; font-size: 11px; }
.name { color: #dde4f8; }
.btn-sm { background: rgba(95,137,255,0.12); color: #9ab9ff; border: 1px solid rgba(122,150,204,0.3); padding: 1px 7px; border-radius: 999px; font-size: 11px; cursor: pointer; font-family: inherit; margin-left: 4px; }
.btn-sm:hover { background: rgba(95,137,255,0.28); color: #fff; }
.input-row { display: flex; gap: 5px; margin-left: 4px; }
.textinput { background: #0d111a; color: #eef4ff; border: 1px solid rgba(121,156,226,0.3); padding: 1px 7px; border-radius: 6px; font-size: 11px; font-family: inherit; outline: none; width: 130px; }
.empty { padding: 24px; color: var(--muted); text-align: center; font-size: 12px; }
.status { color: var(--muted); font-size: 12px; flex: 1; }
</style></head><body>
<div class="toolbar">
    <span class="status" id="status">PlayerGui tree</span>
    <button class="btn" onclick="refresh()">↺ Refresh</button>
</div>
<div class="tree" id="tree"><div class="empty">Loading PlayerGui tree...<br>Make sure a client is connected.</div></div>
<script>
    const vscodeApi = acquireVsCodeApi();
    function esc(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
    function refresh() { vscodeApi.postMessage({ type: 'refresh' }); document.getElementById('status').textContent = 'Refreshing...'; }
    function renderTree(lines) {
        const tree = document.getElementById('tree');
        tree.innerHTML = '';
        if (!lines.length) { tree.innerHTML = '<div class="empty">PlayerGui is empty.</div>'; return; }
        lines.forEach(line => {
            const indent = line.match(/^(\\s*)/)[1].length / 2;
            const rest = line.trim();
            const sep = rest.indexOf('|');
            const cls = sep >= 0 ? rest.slice(0, sep) : rest;
            const name = sep >= 0 ? rest.slice(sep + 1) : '';
            const path = 'PlayerGui.' + name;
            const div = document.createElement('div');
            div.className = 'node';
            div.style.paddingLeft = (12 + indent * 14) + 'px';
            let actions = '';
            if (cls === 'TextButton' || cls === 'ImageButton') {
                actions = '<button class="btn-sm" data-action="click" data-path="' + esc(path) + '">Click</button>';
            } else if (cls === 'TextBox') {
                actions = '<div class="input-row"><input class="textinput" placeholder="text..." id="ti_' + esc(name) + '"><button class="btn-sm" data-action="settext" data-path="' + esc(path) + '" data-input="ti_' + esc(name) + '">Set</button></div>';
            }
            div.innerHTML = '<span class="cls">' + esc(cls) + '</span><span class="name">' + esc(name) + '</span>' + actions;
            tree.appendChild(div);
        });
    }
    document.getElementById('tree').addEventListener('click', ev => {
        const btn = ev.target.closest('[data-action]');
        if (!btn) return;
        const action = btn.dataset.action;
        const path = btn.dataset.path;
        if (action === 'click') {
            vscodeApi.postMessage({ type: 'click', path });
        } else if (action === 'settext') {
            const input = document.getElementById(btn.dataset.input);
            vscodeApi.postMessage({ type: 'settext', path, text: input ? input.value : '' });
        }
    });
    let treeLines = [], inTree = false;
    window.addEventListener('message', ev => {
        const m = ev.data;
        if (m.type === 'guilog') {
            const line = m.line;
            if (line === '[VSRXVC_GUI_TREE_START]') { treeLines = []; inTree = true; return; }
            if (line === '[VSRXVC_GUI_TREE_END]') { inTree = false; renderTree(treeLines); document.getElementById('status').textContent = treeLines.length + ' nodes'; return; }
            if (inTree && line.startsWith('[VSRXVC_GUI] ')) { treeLines.push(line.slice(13)); }
        }
    });
<\/script></body></html>`;
}

function generateInstanceSearchLua(selector: string): string {
    const escaped = selector.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `
local function findBySelector(sel)
    local results = {}
    if sel:sub(1, 1) == '#' then
        -- #Name
        local name = sel:sub(2)
        local obj = workspace:FindFirstChild(name, true) or game:GetService("ReplicatedStorage"):FindFirstChild(name, true)
        if obj then table.insert(results, obj) end
    elseif sel:sub(1, 1) == '.' then
        -- .Tag or .ClassName
        local tag = sel:sub(2)
        if game:GetService("CollectionService"):HasTag then
            results = game:GetService("CollectionService"):GetTagged(tag)
        end
    else
        -- ClassName search
        for _, v in ipairs(game:GetDescendants()) do
            if v.ClassName == sel or v:IsA(sel) then table.insert(results, v) end
        end
    end
    return results
end
local matches = findBySelector("${escaped}")
for i, match in ipairs(matches) do
    print("[VSRXVC_INST] " .. i .. ": " .. match:GetFullName() .. " [" .. match.ClassName .. "]")
end
if #matches == 0 then print("[VSRXVC_INST] No matches found for: ${escaped}") end
`;
}

function getInstanceSearchHtml(): string {
    return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { background: #1a1a1a; color: #d4d4d4; font-family: Consolas, 'Courier New', monospace; font-size: 13px; padding: 10px; }
.search-box { display: flex; gap: 5px; margin-bottom: 10px; }
input { flex: 1; background: #2d2d2d; color: #ccc; border: 1px solid #444; padding: 6px; border-radius: 3px; font-size: 13px; outline: none; }
input:focus { border-color: #a35fff; }
.btn { background: #3a3a3a; color: #bbb; border: 1px solid #555; padding: 6px 12px; cursor: pointer; border-radius: 3px; font-size: 12px; }
.btn:hover { background: #4a4a4a; color: #fff; }
.help { color: #666; font-size: 12px; margin-top: 5px; }
.results { border-top: 1px solid #333; padding-top: 10px; margin-top: 10px; }
.instance { background: #2d2d2d; padding: 8px; margin: 5px 0; border-left: 3px solid #a35fff; cursor: pointer; border-radius: 2px; }
.instance:hover { background: #3a3a3a; }
.instance-name { font-weight: bold; color: #569cd6; }
.instance-class { color: #888; font-size: 11px; margin-top: 3px; }
.instance-path { color: #666; font-size: 11px; word-break: break-all; }
</style></head><body>
<div class="search-box">
  <input id="selector" type="text" placeholder="e.g. Part, #MyPart, .Tag, or Humanoid" />
  <button class="btn" onclick="search()">Search</button>
</div>
<div class="help">ClassName, #Name, .Tag, or Humanoid</div>
<div class="results" id="results"></div>
<script>
  const vscodeApi = acquireVsCodeApi();
  function search() {
    const selector = document.getElementById('selector').value.trim();
    if (!selector) return;
    document.getElementById('results').innerHTML = '<div style="color:#999">Searching in Roblox...</div>';
    vscodeApi.postMessage({ type: 'search', selector });
  }
  document.getElementById('selector').addEventListener('keypress', e => e.key === 'Enter' && search());
  window.addEventListener('message', ev => {
    const m = ev.data;
    if (m.type === 'instances') {
      document.getElementById('results').innerHTML = '';
      for (const inst of m.instances) {
        const div = document.createElement('div');
        div.className = 'instance';
        div.innerHTML = \`<span class="instance-name">\${inst.name}</span><br/><span class="instance-class">\${inst.class}</span><br/><span class="instance-path">\${inst.path}</span>\`;
        document.getElementById('results').appendChild(div);
      }
    }
  });
</script></body></html>`;
}

async function setupCopilotFiles(context: vscode.ExtensionContext, _force: boolean) {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) { return; }

    const templatesDir = path.join(context.extensionPath, 'resources');
    const instructionsTmpl = path.join(templatesDir, 'copilot-instructions.tmpl');
    const agentTmpl = path.join(templatesDir, 'roblox-agent.tmpl');

    if (!fs.existsSync(instructionsTmpl) || !fs.existsSync(agentTmpl)) { return; }

    for (const folder of folders) {
        const root = folder.uri.fsPath;
        const githubDir = path.join(root, '.github');
        const agentsDir = path.join(githubDir, 'agents');
        const instructionsDest = path.join(githubDir, 'copilot-instructions.md');
        const agentDest = path.join(agentsDir, 'roblox.agent.md');

        try {
            if (!fs.existsSync(githubDir)) { fs.mkdirSync(githubDir, { recursive: true }); }
            if (!fs.existsSync(agentsDir)) { fs.mkdirSync(agentsDir, { recursive: true }); }

            fs.copyFileSync(instructionsTmpl, instructionsDest);
            fs.copyFileSync(agentTmpl, agentDest);
        } catch (e: any) {
            vscode.window.showErrorMessage(`VSRX: Failed to create Copilot files - ${e.message}`);
        }
    }
}

export function deactivate() {
    if (server) {
        server.stop();
    }
    if (consolePanel) {
        consolePanel.dispose();
    }
}
