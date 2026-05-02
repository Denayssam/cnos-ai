import { buildRepoMap } from '../../utils/repoMap';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'get_repo_map',
    description:
      'Generate a panoramic, Aider-style map of the active workspace (or worktree, when one is open). ' +
      'Output is two-tiered: (1) a directory TREE up to depth 6 with a per-file symbol count in parentheses, ' +
      'followed by (2) per-file symbol blocks — TS/JS exports via TypeScript AST, plus regex-extracted ' +
      'top-level functions/classes for Python, Go, Rust, Java, Ruby, C#, PHP, Kotlin, Swift. ' +
      'MANDATORY USE: call this BEFORE editing any file you have not already read in this session. ' +
      'Skipping it leads to MATCH ERRORS, ghost imports, and panicked grep loops. ' +
      'After calling, navigate directly with read_file (verbatim) or replace_symbol (AST-bounded).',
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
