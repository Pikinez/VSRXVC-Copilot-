import * as http from 'http';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

interface ClientInfo {
    name: string;
    userId: string;
    startTime: number;
    lastSeen: number;
    ip: string;
    pendingScript: string[];
    executorName: string | null;
    executionEnabled: boolean;
    placeId: string | null;
    gameName: string | null;
}

export interface LogEntry {
    message: string;
    type: number;
    playerName: string;
}

export class VSRXServer {
    private server: http.Server;
    public connectedClients = new Map<string, ClientInfo>();
    private cachedLocalIP: string | null = null;
    readonly port = 6732;
    public onLogReceived: ((log: LogEntry) => void) | null = null;
    public consoleEnabled = true;
    public internalUIEnabled = false;
    public showUIOnLoad = false;
    public defaultSavePath = "";
    private logBuffer: (LogEntry & { timestamp: number })[] = [];
    private readonly LOG_BUFFER_MAX = 200;
    private gameNameCache = new Map<string, string>();
    private authToken: string = '';

    constructor() {
        this.server = http.createServer((req, res) => this.handleRequest(req, res));

        setInterval(() => {
            const now = Date.now();
            for (const [id, data] of this.connectedClients) {
                if (now - data.lastSeen > 10000) {
                    this.connectedClients.delete(id);
                }
            }
        }, 5000);
    }

    public start() {
        this.server.listen(this.port, '127.0.0.1', () => {
            console.log(`VSRX Server listening on port ${this.port}`);
        });
    }

    public stop() {
        this.server.close();
    }

    public hasClients(): boolean {
        return this.connectedClients.size > 0;
    }

    public setAuthToken(token: string): void {
        this.authToken = token;
    }

    public getAuthToken(): string {
        return this.authToken;
    }

    private checkToken(req: http.IncomingMessage): boolean {
        if (!this.authToken) { return true; } // not yet set — allow during startup
        const header = req.headers['x-vsrx-token'];
        return header === this.authToken;
    }

    public getExecutorName(): string {
        for (const client of this.connectedClients.values()) {
            if (client.executorName) {
                return client.executorName;
            }
        }
        return "Inject";
    }

    public getGameName(): string | null {
        for (const client of this.connectedClients.values()) {
            if (client.gameName) { return client.gameName; }
        }
        return null;
    }

    private resolveGameName(placeId: string, client: ClientInfo): void {
        if (this.gameNameCache.has(placeId)) {
            client.gameName = this.gameNameCache.get(placeId)!;
            return;
        }
        const options = {
            hostname: 'games.roblox.com',
            path: `/v1/games/multiget-place-details?placeIds=${placeId}`,
            method: 'GET',
            headers: { 'Accept': 'application/json' }
        };
        const req = require('https').request(options, (res: any) => {
            let data = '';
            res.on('data', (chunk: any) => data += chunk);
            res.on('end', () => {
                try {
                    const arr = JSON.parse(data);
                    if (Array.isArray(arr) && arr[0]?.name) {
                        const name: string = arr[0].name;
                        this.gameNameCache.set(placeId, name);
                        for (const c of this.connectedClients.values()) {
                            if (c.placeId === placeId) { c.gameName = name; }
                        }
                    }
                } catch (_) {}
            });
        });
        req.on('error', () => {});
        req.end();
    }

    public getLoaderScript(): string {
        return `-- VSRXVC Smart Master Loader
local ips = { "http://127.0.0.1:${this.port}", "http://10.0.2.2:${this.port}" }
local found = false
for _, ip in ipairs(ips) do
    local s, r = pcall(function() return game:HttpGet(ip .. "/") end)
    if s and type(r) == "string" and r:find("VSRX") then 
        getgenv().VSRXVC_IP = ip 
        found = true 
        break 
    end
end
if found then 
    loadstring(game:HttpGet(getgenv().VSRXVC_IP .. "/loader"))() 
else 
    warn("VSRXVC: Could not connect to any server IP.") 
end`;
    }

    public setClientExecution(clientId: string, enabled: boolean) {
        const client = this.connectedClients.get(clientId);
        if (client) {
            client.executionEnabled = enabled;
        }
    }

    private handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-VSRX-Token');

        if (req.method === 'OPTIONS') {
            res.statusCode = 204;
            res.end();
            return;
        }

        const hostHeader = req.headers.host || 'localhost';
        const url = new URL(req.url || '/', `http://${hostHeader}`);

        if (req.method === 'GET') {
            if (url.pathname === '/') {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'text/html');
                res.end('<h1>VSRXVC Server is Online!</h1><p>You can execute scripts from VS Code now.</p>');
                return;
            }

            if (url.pathname === '/status') {
                const data = Array.from(this.connectedClients.entries()).map(([key, c]) => ({
                    id: key,
                    name: c.name,
                    userId: c.userId,
                    startTime: c.startTime,
                    ip: c.ip,
                    executorName: c.executorName,
                    executionEnabled: c.executionEnabled
                }));
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ clients: data.length, list: data }));
                return;
            }

            if (url.pathname === '/logs') {
                const since = parseInt(url.searchParams.get('since') || '0', 10);
                const filtered = since > 0
                    ? this.logBuffer.filter(l => l.timestamp > since)
                    : this.logBuffer.slice(-50);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(filtered));
                return;
            }

            if (url.pathname === '/logs/clear') {
                this.logBuffer = [];
                res.statusCode = 200;
                res.end('Cleared');
                return;
            }

            if (url.pathname === '/fetch') {
                const clientIP = req.socket.remoteAddress || 'unknown';
                const name = url.searchParams.get('name') || 'Unknown';
                const userId = url.searchParams.get('userId') || '0';
                const executorName = url.searchParams.get('exec') || null;
                const placeId = url.searchParams.get('placeId') || null;
                const clientKey = userId !== '0' ? userId : clientIP;

                let client = this.connectedClients.get(clientKey);
                if (!client) {
                    client = {
                        name,
                        userId,
                        startTime: Date.now(),
                        lastSeen: Date.now(),
                        ip: clientIP,
                        pendingScript: [],
                        executorName: executorName !== 'null' ? executorName : null,
                        executionEnabled: true,
                        placeId: placeId,
                        gameName: null
                    };
                    this.connectedClients.set(clientKey, client);
                } else {
                    client.lastSeen = Date.now();
                    client.name = name;
                    if (executorName && executorName !== 'null') {
                        client.executorName = executorName;
                    }
                }
                if (placeId && client.placeId !== placeId) {
                    client.placeId = placeId;
                    client.gameName = null;
                }
                if (placeId && !client.gameName) {
                    this.resolveGameName(placeId, client);
                }

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                const script = client.pendingScript.join('\n');
                client.pendingScript = [];

                const responseData = {
                    script: script,
                    token: this.authToken,
                    config: {
                        enableConsole: this.consoleEnabled,
                        enableInternalUI: this.internalUIEnabled,
                        showUIOnLoad: this.showUIOnLoad
                    }
                };
                res.end(JSON.stringify(responseData));
                return;
            }

            if (url.pathname === '/saved-scripts') {
                if (!this.defaultSavePath || !fs.existsSync(this.defaultSavePath)) {
                    res.statusCode = 200;
                    res.end(JSON.stringify([]));
                    return;
                }
                try {
                    const files = fs.readdirSync(this.defaultSavePath)
                        .filter(f => f.endsWith('.lua') || f.endsWith('.txt'))
                        .filter(f => !fs.statSync(path.join(this.defaultSavePath, f)).isDirectory());
                    res.statusCode = 200;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(files));
                } catch (e) {
                    res.statusCode = 500;
                    res.end('[]');
                }
                return;
            }

            if (url.pathname === '/execute-saved') {
                const fileName = url.searchParams.get('name');
                if (fileName && this.defaultSavePath) {
                    const filePath = path.join(this.defaultSavePath, fileName);
                    if (fs.existsSync(filePath)) {
                        try {
                            const content = fs.readFileSync(filePath, 'utf8');
                            for (const client of this.connectedClients.values()) {
                                if (client.executionEnabled) {
                                    client.pendingScript.push(content);
                                }
                            }
                            res.statusCode = 200;
                            res.end('Executed');
                        } catch (e) {
                            res.statusCode = 500;
                            res.end('Error reading file');
                        }
                    } else {
                        res.statusCode = 404;
                        res.end('File not found');
                    }
                } else {
                    res.statusCode = 400;
                    res.end('Missing name');
                }
                return;
            }

            if (url.pathname === '/iris-menu') {
                try {
                    const scriptPath = path.join(__dirname, '..', 'resources', 'scripts', 'iris_menu.lua');
                    if (fs.existsSync(scriptPath)) {
                        const content = fs.readFileSync(scriptPath, 'utf8');
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(content);
                    } else {
                        res.statusCode = 404;
                        res.end('-- Iris menu script not found on server');
                    }
                } catch (e) {
                    res.statusCode = 500;
                    res.end('-- Error loading Iris menu script');
                }
                return;
            }

            if (url.pathname === '/lucide') {
                try {
                    const scriptPath = path.join(__dirname, '..', 'resources', 'scripts', 'lucide-roblox.luau');
                    if (fs.existsSync(scriptPath)) {
                        const content = fs.readFileSync(scriptPath, 'utf8');
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(content);
                    } else {
                        res.statusCode = 404;
                        res.end('-- Lucide module not found on server');
                    }
                } catch (e) {
                    res.statusCode = 500;
                    res.end('-- Error loading lucide module');
                }
                return;
            }

            if (url.pathname === '/loader') {
                try {
                    const host = req.headers.host || `127.0.0.1:${this.port}`;
                    const scriptPath = path.join(__dirname, '..', 'resources', 'scripts', 'loader.lua');
                    if (fs.existsSync(scriptPath)) {
                        let content = fs.readFileSync(scriptPath, 'utf8');

                        // Simple baseUrl injection (fallback only)
                        content = content.replace(/local baseUrl = getgenv\(\)\.VSRXVC_IP\s*/, `local baseUrl = getgenv().VSRXVC_IP or "http://${host}"\n`);

                        // All other configs are handled via /fetch JSON poll

                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'text/plain');
                        res.end(content);
                    } else {
                        res.statusCode = 404;
                        res.end('-- Loader script not found on server');
                    }
                } catch (e) {
                    res.statusCode = 500;
                    res.end('-- Error loading loader script');
                }
                return;
            }

            // No GET route matched
            res.statusCode = 404;
            res.end('Not Found');
            return;
        }

        if (req.method === 'POST') {
            let body = '';
            let bodySize = 0;
            const MAX_BODY_SIZE = 512 * 1024; // 512 KB
            req.on('data', (chunk: Buffer) => {
                bodySize += chunk.length;
                if (bodySize <= MAX_BODY_SIZE) {
                    body += chunk.toString();
                }
            });
            req.on('end', () => {
                if (bodySize > MAX_BODY_SIZE) {
                    res.statusCode = 413;
                    res.end('Payload Too Large');
                    return;
                }
                if (url.pathname === '/execute') {
                    if (!this.checkToken(req)) {
                        res.statusCode = 403;
                        res.end('Forbidden');
                        return;
                    }
                    try {
                        const data = JSON.parse(body);
                        const script = data.script;
                        let executedCount = 0;
                        for (const client of this.connectedClients.values()) {
                            if (client.executionEnabled) {
                                client.pendingScript.push(script);
                                executedCount++;
                            }
                        }
                        res.statusCode = 200;
                        res.end(JSON.stringify({ queued: executedCount }));
                    } catch (e) {
                        res.statusCode = 400;
                        res.end('Invalid JSON');
                    }
                } else if (url.pathname === '/log') {
                    if (!this.checkToken(req)) {
                        res.statusCode = 403;
                        res.end('Forbidden');
                        return;
                    }
                    try {
                        const data = JSON.parse(body);
                        const entry: LogEntry = {
                            message: data.message,
                            type: data.type,
                            playerName: data.player
                        };
                        // Buffer the log
                        this.logBuffer.push({ ...entry, timestamp: Date.now() });
                        if (this.logBuffer.length > this.LOG_BUFFER_MAX) {
                            this.logBuffer.shift();
                        }
                        if (this.onLogReceived) {
                            this.onLogReceived(entry);
                        }
                        res.statusCode = 200;
                        res.end('OK');
                    } catch (e) {
                        res.statusCode = 400;
                        res.end('Invalid JSON');
                    }
                } else if (url.pathname === '/toggle') {
                    try {
                        const data = JSON.parse(body);
                        const clientId = data.id;
                        const enabled = typeof data.enabled === 'boolean' ? data.enabled : false;
                        this.setClientExecution(clientId, enabled);
                        res.statusCode = 200;
                        res.end('Toggled');
                    } catch (e) {
                        res.statusCode = 400;
                        res.end('Invalid JSON');
                    }
                } else if (url.pathname === '/copilot-execute') {
                    try {
                        const data = JSON.parse(body);
                        const script = data.script;
                        if (typeof script !== 'string' || !script.trim()) {
                            res.statusCode = 400;
                            res.end('Missing or empty script');
                            return;
                        }
                        const count = this.executeScriptFromAgent(script);
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({ queued: count }));
                    } catch (e) {
                        res.statusCode = 400;
                        res.end('Invalid JSON');
                    }
                } else {
                    res.statusCode = 404;
                    res.end('Not Found');
                }
            });
            return;
        }

        // Unknown HTTP method
        res.statusCode = 405;
        res.end('Method Not Allowed');
    }

    public executeScriptFromAgent(script: string): number {
        let executedCount = 0;
        for (const client of this.connectedClients.values()) {
            if (client.executionEnabled) {
                client.pendingScript.push(script);
                executedCount++;
            }
        }
        return executedCount;
    }
}
