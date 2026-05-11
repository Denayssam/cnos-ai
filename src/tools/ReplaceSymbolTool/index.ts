import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_symbol',
    description: `Replace a named function/class/component via LSP — no line counting.
Call get_code_structure first to confirm the exact symbol_name (case-sensitive). On not-found the file is untouched; retry with the correct name. For files without LSP support use search_and_replace.`,
    parameters: {
      type: 'object',
      properties: {
        file_path:    { type: 'string', description: 'File path relative to workspace root (e.g. "src/components/Dashboard.tsx").' },
        symbol_name:  { type: 'string', description: 'Exact name of the function, class, or variable to replace (case-sensitive, e.g. "handleDelete" or "AdminDashboard"). Must match the AST node name exactly.' },
        new_code:     { type: 'string', description: 'Complete replacement code for the symbol. Include the full function/class signature and body. The engine will replace the old node boundaries with this text exactly.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY when the user explicitly authorized you to bypass the Sherlock Auditor (e.g. "fix the duplicate anyway", "I know about it, force the change"). Combined with the engine\'s user-override marker check, this lets the edit through even if Sherlock would otherwise flag REDUNDANT_DECLARATION. Quote the user\'s override phrase in your reasoning so the engine can verify.' },
      },
      required: ['file_path', 'symbol_name', 'new_code'],
    },
  },
};

// Real execution is intercepted by agentEngine.ts (replaceSymbolCallback from extension.ts).
// This path is a safety fallback only — in production the engine never reaches it.
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM ENGINE ERROR]: replace_symbol must be intercepted by the LSP callback in extension.ts. Ensure the extension host is active.',
  };
}
