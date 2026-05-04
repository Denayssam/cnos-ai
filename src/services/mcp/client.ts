// ─── Fluxo MCP Service Layer (v8.26.0 — Phase 3.4) ──────────────────────────
//
// History: this file used to live at src/mcpClient.ts as the monolithic MCP
// integration surface. v8.26.0 extracts it into a dedicated services layer
// (`src/services/mcp/`) in preparation for Phase 4 work — n8n/SaaS automation
// flows that need additional services (resource discovery, prompt templates,
// long-running webhook handlers) to live alongside the client without
// re-monolithizing.
//
// What MOVED unchanged from src/mcpClient.ts (zero behavior regression):
//   • McpServerConfig interface
//   • CATEGORY_KEYWORDS heuristic + inferCategories()
//   • McpSwarmClient class — _loadMergedConfig (auto-injection of starter
//     pack via ensureStarterPack), _resolveServerConfig (${ENV:...} /
//     ${ARG:...} placeholder resolution), _initializeAsync with
//     Promise.allSettled parallel boot + 30s connect timeout + transport
//     cleanup on timeout, _cacheTools with explicit/inferred category
//     merging, and the public surface (initialize, getMcpTools,
//     getMcpToolCategories, callMcpTool, destroy).
//
// What is NEW in v8.26.0:
//   • listResources(serverName) — atomic discovery of remote resources
//     (n8n workflow files, DB schemas, config blobs) for the new
//     ListMcpResourcesTool. Wired through the agent engine via a callback
//     interceptor so @planner and @manager can enumerate what an MCP
//     server exposes BEFORE deciding which tool to call.
//
// PRESERVED INVARIANTS (must remain true on every refactor):
//   1. Parallel boot via Promise.allSettled — no server's slow npx fetch
//      blocks the others; one failed server does not abort the batch.
//   2. RBAC category map (toolCategories) is keyed by full mcp_<server>_<tool>
//      name and consumed by agentEngine.applyMcpRbac at runtime.
//   3. Placeholder resolution runs on every string in args + every value in
//      env BEFORE the StdioClientTransport is constructed.
//   4. ensureStarterPack is idempotent — re-running on a workspace with
//      existing .fluxo/mcp_servers.json is a no-op.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeTool } from '../../tools';
import { ensureStarterPack } from '../../utils/mcpConfigWriter';
import { resolvePlaceholders } from '../../utils/mcpRegistry';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Optional v8.19.0 — explicit categories for this server's tools, used by
   * the RBAC filter when the heuristic inference cannot classify them. Authors
   * of mcp_servers.json can pin a server's tools to one or more roles.
   * Examples: ["design", "figma"], ["database", "git"], ["pm", "jira"].
   */
  categories?: string[];
}

// ─── Category Inference (v8.19.0, moved verbatim in v8.26.0) ────────────────
// Heuristic mapping from server/tool/description text to RBAC categories.
// Multi-tag: a single tool can carry several categories (e.g. GitHub provides
// both git ops and issue/PR project-management surfaces). The RBAC filter in
// agentEngine treats a tool as allowed if ANY of its categories overlaps the
// agent's allowed set.

const CATEGORY_KEYWORDS: Record<string, RegExp> = {
  design:   /\b(design|ui|ux|css|sketch|wireframe|mockup|prototype|color)\b/i,
  figma:    /\b(figma)\b/i,
  image:    /\b(image|photo|illustration|icon|svg|png|jpg|asset)\b/i,
  database: /\b(database|db|sql|postgres|postgresql|mysql|mariadb|mongo|mongodb|redis|sqlite|query|nosql|prisma|supabase|firebase)\b/i,
  compiler: /\b(compile|compiler|build|lint|linter|tsc|typescript|gcc|rustc|webpack|vite|esbuild|swc)\b/i,
  git:      /\b(git|repo|repository|branch|commit|merge|pull[\s-]?request|pr\b|gitlab|bitbucket)\b/i,
  github:   /\b(github)\b/i,
  pm:       /\b(jira|linear|asana|trello|notion|monday|clickup|project|ticket|issue|backlog|sprint|kanban)\b/i,
  jira:     /\b(jira|atlassian)\b/i,
  devops:   /\b(docker|kubernetes|k8s|deploy|deployment|ci\/?cd|pipeline|terraform|ansible|aws|gcp|azure)\b/i,
};

export function inferCategories(serverName: string, toolName: string, description: string): string[] {
  const haystack = `${serverName} ${toolName} ${description}`.toLowerCase();
  const cats = new Set<string>();
  for (const [cat, re] of Object.entries(CATEGORY_KEYWORDS)) {
    if (re.test(haystack)) { cats.add(cat); }
  }
  return Array.from(cats);
}

export class McpSwarmClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();

  private cachedTools: NativeTool[] = [];
  private toolCategories: Record<string, string[]> = {};
  private isInitialized = false;
  private workspacePath: string | undefined;

  /**
   * v8.19.0 — workspacePath is optional but recommended. When provided, the
   * client also reads .fluxo/mcp_servers.json from the workspace and merges it
   * with the user-level fluxo.mcpServers VSCode setting. The workspace JSON
   * wins on key collisions, so a project can pin its own MCP stack.
   */
  constructor(workspacePath?: string) {
    this.workspacePath = workspacePath;
  }

  public initialize() {
    this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
  }

  private _loadMergedConfig(): Record<string, McpServerConfig> {
    const userConfig = vscode.workspace.getConfiguration('fluxo')
      .get<Record<string, McpServerConfig>>('mcpServers') || {};

    let workspaceConfig: Record<string, McpServerConfig> = {};
    if (this.workspacePath) {
      // v8.20.0 — Zero-Config Auto-Injection. If the workspace has never
      // configured MCP, drop a starter pack JSON onto disk before we try to
      // read it. ensureStarterPack is idempotent and only writes when the
      // file is missing, so a user who deleted everything intentionally is
      // never surprised by a re-seed mid-session.
      try {
        const written = ensureStarterPack(this.workspacePath);
        if (written.length > 0) {
          console.log(`[Fluxo MCP] Auto-injected starter pack into .fluxo/mcp_servers.json: ${written.join(', ')}`);
        }
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to auto-inject starter pack: ${err?.message ?? err}`);
      }

      const fp = path.join(this.workspacePath, '.fluxo', 'mcp_servers.json');
      try {
        if (fs.existsSync(fp)) {
          const raw = fs.readFileSync(fp, 'utf-8');
          const parsed = JSON.parse(raw);
          // Accept both root-level map and { mcpServers: { ... } } envelope.
          if (parsed && typeof parsed === 'object') {
            workspaceConfig = (parsed.mcpServers ?? parsed) as Record<string, McpServerConfig>;
          }
          console.log(`[Fluxo MCP] Loaded .fluxo/mcp_servers.json (${Object.keys(workspaceConfig).length} server(s))`);
        }
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to read .fluxo/mcp_servers.json: ${err?.message ?? err}`);
      }
    }

    // Workspace JSON wins on collisions — projects can pin their own MCP stack.
    return { ...userConfig, ...workspaceConfig };
  }

  /**
   * v8.20.0 — resolve ${ENV:...} / ${ARG:...:default} placeholders in a
   * server config before we hand it to the StdioClientTransport. Applied to
   * every string in args + every value in env. Servers that need a real env
   * var (BRAVE_API_KEY, GITHUB_TOKEN) read it from process.env transparently.
   */
  private _resolveServerConfig(serverConfig: McpServerConfig): McpServerConfig {
    const resolved: McpServerConfig = {
      command: resolvePlaceholders(serverConfig.command),
      args: serverConfig.args?.map(a => resolvePlaceholders(a)),
    };
    if (serverConfig.env) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(serverConfig.env)) {
        env[k] = resolvePlaceholders(v);
      }
      resolved.env = env;
    }
    return resolved;
  }

  private async _initializeAsync() {
    const config = this._loadMergedConfig();
    if (!config || Object.keys(config).length === 0) {
      this.isInitialized = true;
      return;
    }

    // v8.20.0 — Parallel boot. Cold `npx -y` fetches can take 10-30s on a
    // fresh cache; running servers serially used to make startup time scale
    // linearly with N servers. Parallelizing keeps total init bounded by the
    // slowest server. A failure on one server never blocks the others, and
    // never throws — the whole batch is wrapped in Promise.allSettled.
    //
    // Per-server connect timeout bumped 5s → 30s so first-run npx fetches
    // have headroom. Transports that miss the deadline are explicitly
    // closed to avoid orphan node processes.
    const CONNECT_TIMEOUT_MS = 30_000;
    await Promise.allSettled(
      Object.entries(config).map(async ([serverName, rawConfig]) => {
        const serverConfig = this._resolveServerConfig(rawConfig);
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...process.env, ...serverConfig.env } as Record<string, string>
        });

        const client = new Client(
          { name: 'fluxo-ai', version: '8.26.0' },
          { capabilities: {} }
        );

        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Connection timeout (${CONNECT_TIMEOUT_MS}ms) — likely a slow npx fetch on first run`)), CONNECT_TIMEOUT_MS))
          ]);
          this.clients.set(serverName, client);
          this.transports.set(serverName, transport);
          console.log(`[Fluxo MCP] Connected to server: ${serverName}`);
        } catch (err: any) {
          console.error(`[Fluxo MCP] Failed to connect to server ${serverName}:`, err?.message ?? err);
          // Clean up the transport on failure so we don't leak a dangling
          // child process holding a stdio pipe.
          try { await transport.close(); } catch { /* nothing more to clean */ }
        }
      })
    );

    await this._cacheTools(config);
    this.isInitialized = true;
  }

  private async _cacheTools(config: Record<string, McpServerConfig>) {
    const allTools: NativeTool[] = [];
    const categoryMap: Record<string, string[]> = {};

    for (const [serverName, client] of this.clients.entries()) {
      try {
        const response = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
        ]) as any;

        const explicitCategories = config[serverName]?.categories ?? [];

        for (const t of response.tools) {
          const fullName    = `mcp_${serverName}_${t.name}`;
          const description = `[MCP Server: ${serverName}] ${t.description || ''}`;
          allTools.push({
            type: 'function',
            function: {
              name: fullName,
              description,
              parameters: (t.inputSchema as any) || { type: 'object', properties: {} }
            }
          });

          // Merge explicit (config-pinned) + inferred categories. Explicit wins
          // on intent but inferred cats add coverage if the author missed any.
          const inferred = inferCategories(serverName, t.name, t.description || '');
          const merged   = Array.from(new Set([...explicitCategories, ...inferred]));
          categoryMap[fullName] = merged;
        }
      } catch (err) {
        console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
      }
    }

    this.cachedTools    = allTools;
    this.toolCategories = categoryMap;
  }

  public getMcpTools(): NativeTool[] {
    return this.cachedTools;
  }

  /**
   * v8.19.0 — return the per-tool category map keyed by full tool name (e.g.
   * "mcp_github_create_issue" → ["github", "git", "pm"]). Consumed by the
   * RBAC filter in agentEngine.ts. Tools whose keyword inference returns no
   * matches AND whose server config did not pin categories appear here with
   * an empty array — the RBAC filter treats those as "unknown".
   */
  public getMcpToolCategories(): Record<string, string[]> {
    return this.toolCategories;
  }

  public async callMcpTool(fullName: string, args: any): Promise<{ success: boolean; output: string }> {
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
        const textContent = (response.content as any[]).map((c: any) => c.text).join('\n');
        return { success: false, output: `MCP Tool Error:\n${textContent}` };
      }
      const textContent = (response.content as any[]).map((c: any) => c.text).join('\n');
      return { success: true, output: textContent };
    } catch (err: any) {
      return { success: false, output: `MCP call failed: ${err.message}` };
    }
  }

  /**
   * v8.26.0 — Phase 3.4 resource discovery. MCP servers expose two parallel
   * surfaces: `tools` (callable functions, already cached during init) and
   * `resources` (readable URIs — n8n workflow JSON blobs, database schemas,
   * config files, prompt templates). The agent needs to enumerate resources
   * BEFORE deciding which tool to call against them, much like an LSP
   * `textDocument/documentSymbol` precedes a refactor.
   *
   * Returns the same { success, output } envelope as callMcpTool so the
   * engine intercept and the existing tool-result pipeline treat it
   * uniformly. Output is a human-readable list (uri / name / mimeType /
   * description) — formatted for direct injection into the LLM's context
   * with low parsing overhead.
   *
   * Defensive: if the server does not advertise the resources/list capability
   * the SDK throws — we trap and return a clean failure rather than letting
   * the engine see a raw exception.
   */
  public async listResources(serverName: string): Promise<{ success: boolean; output: string }> {
    if (!serverName || typeof serverName !== 'string') {
      return { success: false, output: 'list_mcp_resources: missing or invalid `server_name` argument.' };
    }
    const client = this.clients.get(serverName);
    if (!client) {
      const available = Array.from(this.clients.keys());
      return {
        success: false,
        output:
          `MCP Server not found: "${serverName}". ` +
          (available.length > 0
            ? `Available servers: ${available.join(', ')}.`
            : 'No MCP servers are currently connected — check .fluxo/mcp_servers.json.'),
      };
    }
    try {
      const response = await Promise.race([
        client.listResources(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('listResources timeout (5s)')), 5000)),
      ]) as any;
      const resources: any[] = Array.isArray(response?.resources) ? response.resources : [];
      if (resources.length === 0) {
        return {
          success: true,
          output: `MCP server "${serverName}" exposes 0 resources. The server may only provide tools, or the resources/list capability is unimplemented.`,
        };
      }
      const lines = resources.slice(0, 50).map(r => {
        const parts = [
          `uri: ${r.uri ?? '(missing)'}`,
          `name: ${r.name ?? '(unnamed)'}`,
        ];
        if (r.mimeType) { parts.push(`mimeType: ${r.mimeType}`); }
        if (r.description) { parts.push(`description: ${String(r.description).slice(0, 200)}`); }
        return `- ${parts.join(' | ')}`;
      });
      const truncated = resources.length > 50 ? `\n…(showing first 50 of ${resources.length})` : '';
      return {
        success: true,
        output: `MCP server "${serverName}" exposes ${resources.length} resource(s):\n\n${lines.join('\n')}${truncated}`,
      };
    } catch (err: any) {
      return { success: false, output: `list_mcp_resources("${serverName}") failed: ${err?.message ?? String(err)}` };
    }
  }

  /**
   * v8.26.0 — utility for the new ListMcpResourcesTool's error path. Returns
   * the list of currently connected server names so the tool can suggest
   * valid alternatives when the agent asks about a typo'd server.
   */
  public getConnectedServerNames(): string[] {
    return Array.from(this.clients.keys());
  }

  public async destroy() {
    for (const [serverName, transport] of this.transports.entries()) {
      try {
        await transport.close();
        console.log(`[Fluxo MCP] Disconnected from server: ${serverName}`);
      } catch (err) {
        console.error(`[Fluxo MCP] Error closing transport for ${serverName}:`, err);
      }
    }
    this.clients.clear();
    this.transports.clear();
  }
}
