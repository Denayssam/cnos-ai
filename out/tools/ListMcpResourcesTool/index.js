"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
// ─── ListMcpResourcesTool (v8.26.0 — Phase 3.4 Discovery) ───────────────────
//
// MCP servers expose two parallel surfaces: `tools` (callable functions, which
// the engine already discovers and caches at boot via McpSwarmClient._cacheTools)
// and `resources` (readable URIs — n8n workflow JSON blobs, database schemas,
// configuration documents, prompt templates). The cached tool list does NOT
// reveal what resources are available; agents need an explicit discovery step
// before they can decide which tool to invoke against which resource.
//
// This tool gives @planner and @manager an atomic discovery primitive: pass a
// `server_name` (the alias from .fluxo/mcp_servers.json), get back a
// human-readable list of resources (uri / name / mimeType / description) that
// server exposes. Output is formatted for direct LLM consumption.
//
// EXECUTION MODEL: like get_code_structure / replace_symbol / mcp_*, this
// tool requires the live McpSwarmClient instance which lives in the extension
// host (it owns the open stdio transports). The synchronous execute() below
// is a placeholder; the real work happens in agentEngine.ts via the
// `listMcpResourcesCallback` injected through runAgentLoop. The placeholder
// only fires if the callback is missing (e.g. running outside the extension
// host) and surfaces a clear "engine integration error" rather than a silent
// hang.
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'list_mcp_resources',
        description: 'Discover what resources (readable URIs — n8n workflow JSONs, DB schemas, ' +
            'prompt templates, config documents) a specific MCP server exposes. ' +
            'Returns a list of {uri, name, mimeType, description} entries. ' +
            'WHEN TO USE: before calling an mcp_<server>_<tool> that operates on a remote ' +
            'resource — call this first to learn the exact URIs available, then pass them ' +
            'verbatim to the tool. Avoids hallucinating non-existent resource paths. ' +
            'WHEN NOT TO USE: do not call this for every server you know about — only call ' +
            'when you are about to perform an operation that needs the resource list.',
        parameters: {
            type: 'object',
            properties: {
                server_name: {
                    type: 'string',
                    description: 'The MCP server alias as it appears in .fluxo/mcp_servers.json ' +
                        '(e.g. "github", "n8n", "memory", "sqlite"). Case-sensitive.',
                },
            },
            required: ['server_name'],
        },
    },
};
// Real execution is intercepted by agentEngine.ts (listMcpResourcesCallback
// from extension.ts → McpSwarmClient.listResources). This synchronous path is
// a defense-in-depth fallback only — in production the engine never reaches
// it because the intercept fires before executeTool dispatches.
function execute(_args, _workspacePath) {
    return {
        success: false,
        output: '[SYSTEM ENGINE ERROR]: list_mcp_resources must be intercepted by the McpSwarmClient callback in extension.ts. Ensure the extension host is active and the MCP service layer initialized.',
    };
}
//# sourceMappingURL=index.js.map