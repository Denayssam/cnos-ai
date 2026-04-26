import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content. Only use for NEW files — for existing files, always use edit_file to avoid overwriting unrelated code.',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'File path relative to workspace root.' },
        content: { type: 'string', description: 'Complete file content to write.' },
      },
      required: ['path', 'content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
  }
  const fp = safePath(workspacePath, args.path);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, args.content, 'utf-8');
  const size = Buffer.byteLength(args.content, 'utf-8');
  return { success: true, output: `Written: ${args.path} (${size} bytes)` };
}
