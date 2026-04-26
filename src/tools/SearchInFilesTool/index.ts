import { NativeTool, ToolResult, safePath, searchRecursive } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_in_files',
    description: 'Search for a text pattern across workspace files. Returns matching file:line results.',
    parameters: {
      type: 'object',
      properties: {
        pattern:   { type: 'string', description: 'The text pattern to search for (case-insensitive).' },
        directory: { type: 'string', description: 'Subdirectory to restrict the search. Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const searchRoot = safePath(workspacePath, args.directory || '.');
  const results: string[] = [];
  searchRecursive(searchRoot, workspacePath, String(args.pattern || ''), results, 0);
  if (results.length === 0) {
    return { success: true, output: 'No matches found.' };
  }
  return { success: true, output: results.slice(0, 60).join('\n') };
}
