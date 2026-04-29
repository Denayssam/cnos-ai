"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'replace_symbol',
        description: `Replace a complete logical block (function, class, variable, React component) by looking up its exact name in the Abstract Syntax Tree (AST) via the VS Code Language Server.

WHEN TO USE: Any time you need to rewrite an entire function, class, or named component. The LSP finds the exact code boundaries — you never count lines or copy snippets.

MANDATORY WORKFLOW:
1. Call get_code_structure or read_file to confirm the exact symbol name (case-sensitive).
2. Call replace_symbol with: file_path, symbol_name, and new_code (your complete replacement).
3. The Language Server locates the AST node, extracts its precise Range, and replaces it atomically.

FAIL-SAFE: If symbol_name is not found, the tool returns an error and the file is NEVER modified.
  → Use get_code_structure to list available symbol names before retrying.

FALLBACK: For files without LSP support (plain text, config files, unsupported languages),
  use replace_block with search_snippet + replace_snippet instead.`,
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'File path relative to workspace root (e.g. "src/components/Dashboard.tsx").' },
                symbol_name: { type: 'string', description: 'Exact name of the function, class, or variable to replace (case-sensitive, e.g. "handleDelete" or "AdminDashboard"). Must match the AST node name exactly.' },
                new_code: { type: 'string', description: 'Complete replacement code for the symbol. Include the full function/class signature and body. The engine will replace the old node boundaries with this text exactly.' },
            },
            required: ['file_path', 'symbol_name', 'new_code'],
        },
    },
};
// Real execution is intercepted by agentEngine.ts (replaceSymbolCallback from extension.ts).
// This path is a safety fallback only — in production the engine never reaches it.
function execute(_args, _workspacePath) {
    return {
        success: false,
        output: '[SYSTEM ENGINE ERROR]: replace_symbol must be intercepted by the LSP callback in extension.ts. Ensure the extension host is active.',
    };
}
//# sourceMappingURL=index.js.map