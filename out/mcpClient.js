"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.McpSwarmClient = void 0;
const vscode = __importStar(require("vscode"));
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
class McpSwarmClient {
    constructor() {
        this.clients = new Map();
        this.transports = new Map();
        this.cachedTools = [];
        this.isInitialized = false;
    }
    initialize() {
        this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
    }
    async _initializeAsync() {
        const config = vscode.workspace.getConfiguration('fluxo').get('mcpServers');
        if (!config || Object.keys(config).length === 0) {
            this.isInitialized = true;
            return;
        }
        for (const [serverName, serverConfig] of Object.entries(config)) {
            try {
                const transport = new stdio_js_1.StdioClientTransport({
                    command: serverConfig.command,
                    args: serverConfig.args,
                    env: { ...process.env, ...serverConfig.env }
                });
                const client = new index_js_1.Client({ name: 'fluxo-ai', version: '7.17.1' }, { capabilities: {} });
                await Promise.race([
                    client.connect(transport),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
                ]);
                this.clients.set(serverName, client);
                this.transports.set(serverName, transport);
                console.log(`[Fluxo MCP] Connected to server: ${serverName}`);
            }
            catch (err) {
                console.error(`[Fluxo MCP] Failed to connect to server ${serverName}:`, err);
            }
        }
        await this._cacheTools();
        this.isInitialized = true;
    }
    async _cacheTools() {
        const allTools = [];
        for (const [serverName, client] of this.clients.entries()) {
            try {
                const response = await Promise.race([
                    client.listTools(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
                ]);
                for (const t of response.tools) {
                    allTools.push({
                        type: 'function',
                        function: {
                            name: `mcp_${serverName}_${t.name}`,
                            description: `[MCP Server: ${serverName}] ${t.description || ''}`,
                            parameters: t.inputSchema || { type: 'object', properties: {} }
                        }
                    });
                }
            }
            catch (err) {
                console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
            }
        }
        this.cachedTools = allTools;
    }
    getMcpTools() {
        return this.cachedTools;
    }
    async callMcpTool(fullName, args) {
        const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
        if (!match) {
            return { success: false, output: `Invalid MCP tool name: ${fullName}` };
        }
        const serverName = match[1];
        const toolName = match[2];
        const client = this.clients.get(serverName);
        if (!client) {
            return { success: false, output: `MCP Server not found: ${serverName}` };
        }
        try {
            const response = await client.callTool({ name: toolName, arguments: args });
            if (response.isError) {
                const textContent = response.content.map((c) => c.text).join('\n');
                return { success: false, output: `MCP Tool Error:\n${textContent}` };
            }
            const textContent = response.content.map((c) => c.text).join('\n');
            return { success: true, output: textContent };
        }
        catch (err) {
            return { success: false, output: `MCP call failed: ${err.message}` };
        }
    }
    async destroy() {
        for (const [serverName, transport] of this.transports.entries()) {
            try {
                await transport.close();
                console.log(`[Fluxo MCP] Disconnected from server: ${serverName}`);
            }
            catch (err) {
                console.error(`[Fluxo MCP] Error closing transport for ${serverName}:`, err);
            }
        }
        this.clients.clear();
        this.transports.clear();
    }
}
exports.McpSwarmClient = McpSwarmClient;
//# sourceMappingURL=mcpClient.js.map