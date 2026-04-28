import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { NativeTool } from './tools';

interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export class McpSwarmClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, StdioClientTransport> = new Map();

  private cachedTools: NativeTool[] = [];
  private isInitialized = false;

  public initialize() {
    this._initializeAsync().catch(err => console.error("[Fluxo MCP] Init error:", err));
  }

  private async _initializeAsync() {
    const config = vscode.workspace.getConfiguration('fluxo').get<Record<string, McpServerConfig>>('mcpServers');
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
          { name: 'fluxo-ai', version: '7.17.1' },
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

    await this._cacheTools();
    this.isInitialized = true;
  }

  private async _cacheTools() {
    const allTools: NativeTool[] = [];
    for (const [serverName, client] of this.clients.entries()) {
      try {
        const response = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('listTools timeout')), 5000))
        ]) as any;
        for (const t of response.tools) {
          allTools.push({
            type: 'function',
            function: {
              name: `mcp_${serverName}_${t.name}`,
              description: `[MCP Server: ${serverName}] ${t.description || ''}`,
              parameters: (t.inputSchema as any) || { type: 'object', properties: {} }
            }
          });
        }
      } catch (err) {
        console.error(`[Fluxo MCP] Failed to list tools for ${serverName}:`, err);
      }
    }
    this.cachedTools = allTools;
  }

  public getMcpTools(): NativeTool[] {
    return this.cachedTools;
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
