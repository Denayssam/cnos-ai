import { buildRepoMap } from '../../utils/repoMap';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'get_repo_map',
    description:
      'Generates a compressed semantic AST map of the entire repository. ' +
      'Use this tool FIRST when exploring a codebase to instantly know where components, functions, and classes are defined ' +
      'without guessing file paths. ' +
      'Returns a multi-line map: each file on its own header line, with its exported symbols indented below it. ' +
      'After calling this, you can navigate directly to any symbol with read_file or replace_symbol.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

export function execute(_args: Record<string, any>, workspacePath: string): ToolResult {
  const map = buildRepoMap(workspacePath);
  if (!map) {
    return {
      success: false,
      output: 'No mappable source files found. Try list_dir(".") to explore the workspace structure manually.',
    };
  }
  return { success: true, output: `REPO MAP:\n\n${map}` };
}
