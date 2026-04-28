import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'get_code_structure',
    description:
      'Uses VS Code\'s Language Server Protocol to extract all symbols (functions, classes, variables, methods) from a file, with their exact start/end line numbers. ' +
      'Use this BEFORE reading or editing a large file to get a precise structural map — so you know exactly which line range to target without reading the entire file.',
    parameters: {
      type: 'object',
      properties: {
        absolute_path: {
          type: 'string',
          description: 'Absolute path to the file to analyze (e.g., /workspace/src/App.tsx).',
        },
      },
      required: ['absolute_path'],
    },
  },
};

// Actual execution is handled by the getCodeStructureCallback in extension.ts (requires VS Code API).
export function execute(_args: Record<string, any>, _workspacePath: string): ToolResult {
  return {
    success: false,
    output: '[SYSTEM]: get_code_structure requires the VS Code extension host. This tool cannot run outside of VS Code.',
  };
}
