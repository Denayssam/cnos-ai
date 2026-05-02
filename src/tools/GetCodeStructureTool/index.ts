import { NativeTool, ToolResult, rejectIfAbsolutePath } from '../shared';

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
          description:
            'Path to the file relative to the workspace root (e.g., src/components/App.tsx). ' +
            'v8.18.1: despite the legacy parameter name, drive-letter and root-slash absolute ' +
            'paths are blocked. Pass the repository-relative path — the engine resolves it ' +
            'against the active workspace.',
        },
      },
      required: ['absolute_path'],
    },
  },
};

// Actual execution is handled by the getCodeStructureCallback in extension.ts (requires VS Code API).
// v8.18.1: defensive absolute-path shield mirrors the engine's intercept guard so the rejection
// is uniform whether the tool runs through the executeTool fallback or the engine's special branch.
export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const absShield = rejectIfAbsolutePath(args.absolute_path);
  if (absShield) { return absShield; }
  return {
    success: false,
    output: '[SYSTEM]: get_code_structure requires the VS Code extension host. This tool cannot run outside of VS Code.',
  };
}
