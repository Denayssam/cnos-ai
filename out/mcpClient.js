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
exports.inferCategories = inferCategories;
const vscode = __importStar(require("vscode"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const index_js_1 = require("@modelcontextprotocol/sdk/client/index.js");
const stdio_js_1 = require("@modelcontextprotocol/sdk/client/stdio.js");
// ─── Category Inference (v8.19.0) ───────────────────────────────────────────
// Heuristic mapping from server/tool/description text to RBAC categories.
// Multi-tag: a single tool can carry several categories (e.g. GitHub provides
// both git ops and issue/PR project-management surfaces). The RBAC filter in
// agentEngine treats a tool as allowed if ANY of its categories overlaps the
// agent's allowed set.
const CATEGORY_KEYWORDS = {
    design: /\b(design|ui|ux|css|sketch|wireframe|mockup|prototype|color)\b/i,
    figma: /\b(figma)\b/i,
    image: /\b(image|photo|illustration|icon|svg|png|jpg|asset)\b/i,
    database: /\b(database|db|sql|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|sqlite|query|nosql|prisma|supabase|firebase)\b/i,
    compiler: /\b(compile|compiler|build|lint|linter|tsc|typescript|gcc|rustc|webpack|vite|esbuild|swc)\b/i,
    git: /\b(git|repo|repository|branch|commit|merge|pull[\s-]?request|pr\b|gitlab|bitbucket)\b/i,
    github: /\b(github)\b/i,
    pm: /\b(jira|linear|asana|trello|notion|monday|clickup|project|ticket|issue|backlog|sprint|kanban)\b/i,
    jira: /\b(jira|atlassian)\b/i,
    devops: /\b(docker|kubernetes|k8s|deploy|deployment|ci\/?cd|pipeline|terraform|ansible|aws|gcp|azure)\b/i,
};
function inferCategories(serverName, toolName, description) {
    const haystack = `${serverName} ${toolName} ${description}`.toLowerCase();
    const cats = new Set();
    for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS)) {
        if (re.test(haystack)) {
            cats.add(cat);
        }
    }
    return Array.from(cats);
}
class McpSwarmClient {
    /**
     * v8.19.0 — workspacePath is optional but recommended. When provided, the
     * client also reads .fluxo/mcp_servers.json from the workspace and merges it
     * with the user-level fluxo.mcpServers VSCode setting. The workspace JSON
     * wins on key collisions, so a project can pin its own MCP stack.
     */
    constructor(workspacePath) {
        this.clients = new Map();
        this.transports = new Map();
        this.cachedTools = [];
        this.toolCategories = {};
        this.isInitialized = false;
        this.workspacePath = workspacePath;
    }
    initialize() {
        this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
    }
    _loadMergedConfig() {
        const userConfig = vscode.workspace.getConfiguration('fluxo')
            .get('mcpServers') || {};
        let workspaceConfig = {};
        if (this.workspacePath) {
            const fp = path.join(this.workspacePath, '.fluxo', 'mcp_servers.json');
            try {
                if (fs.existsSync(fp)) {
                    const raw = fs.readFileSync(fp, 'utf-8');
                    const parsed = JSON.parse(raw);
                    // Accept both root-level map and { mcpServers: { ... } } envelope.
                    if (parsed && typeof parsed === 'object') {
                        workspaceConfig = (parsed.mcpServers ?? parsed);
                    }
                    console.log(`[Fluxo MCP] Loaded .fluxo/mcp_servers.json (${Object.keys(workspaceConfig).length} server(s))`);
                }
            }
            catch (err) {
                console.error(`[Fluxo MCP] Failed to read .fluxo/mcp_servers.json: ${err?.message ?? err}`);
            }
        }
        // Workspace JSON wins on collisions — projects can pin their own MCP stack.
        return { ...userConfig, ...workspaceConfig };
    }
    async _initializeAsync() {
        const config = this._loadMergedConfig();
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
                const client = new index_js_1.Client({ name: 'fluxo-ai', version: '8.19.0' }, { capabilities: {} });
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
        await this._cacheTools(config);
        this.isInitialized = true;
    }
    async _cacheTools(config) {
        const allTools = [];
        const categoryMap = {};
        for (const [serverName, client] of this.clients.entries()) {
            try {
                const response = await Promise.race([
                    client.listTools(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
                ]);
                const explicitCategories = config[serverName]?.categories ?? [];
                for (const t of response.tools) {
                    const fullName = `mcp_${serverName}_${t.name}`;
                    const description = `[MCP Server: ${serverName}] ${t.description || ''}`;
                    allTools.push({
                        type: 'function',
                        function: {
                            name: fullName,
                            description,
                            parameters: t.inputSchema || { type: 'object', properties: {} }
                        }
                    });
                    // Merge explicit (config-pinned) + inferred categories. Explicit wins
                    // on intent but inferred cats add coverage if the author missed any.
                    const inferred = inferCategories(serverName, t.name, t.description || '');
                    const merged = Array.from(new Set([...explicitCategories, ...inferred]));
                    categoryMap[fullName] = merged;
                }
            }
            catch (err) {
                console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
            }
        }
        this.cachedTools = allTools;
        this.toolCategories = categoryMap;
    }
    getMcpTools() {
        return this.cachedTools;
    }
    /**
     * v8.19.0 — return the per-tool category map keyed by full tool name (e.g.
     * "mcp_github_create_issue" → ["github", "git", "pm"]). Consumed by the
     * RBAC filter in agentEngine.ts. Tools whose keyword inference returns no
     * matches AND whose server config did not pin categories appear here with
     * an empty array — the RBAC filter treats those as "unknown".
     */
    getMcpToolCategories() {
        return this.toolCategories;
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