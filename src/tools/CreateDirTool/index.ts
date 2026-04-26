import * as fs from 'fs';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'create_dir',
    description: 'Create a directory and all necessary parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path relative to workspace root.' },
      },
      required: ['path'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path);
  fs.mkdirSync(dp, { recursive: true });
  return { success: true, output: `Directory created: ${args.path}` };
}
