import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeTool } from './tools';

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

// ─── Category Inference (v8.19.0) ───────────────────────────────────────────
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

  private async _initializeAsync() {
    const config = this._loadMergedConfig();
    if (!config || Object.keys(config).length === 0) {
      this.isInitialized = true;
      return;
    }

    for (const [serverName, serverConfig] of Object.entries(config)) {
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: { ...process.env, ...serverConfig.env } as Record<string, string>
        });

        const client = new Client(
          { name: 'fluxo-ai', version: '8.19.0' },
          { capabilities: {} }
        );

        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Connection timeout')), 5000))
        ]);

        this.clients.set(serverName, client);
        this.transports.set(serverName, transport);
        console.log(`[Fluxo MCP] Connected to server: ${serverName}`);
      } catch (err: any) {
        console.error(`[Fluxo MCP] Failed to connect to server ${serverName}:`, err);
      }
    }

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
