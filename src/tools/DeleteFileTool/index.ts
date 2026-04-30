import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_file',
    description: 'Delete a single file from the workspace. Safer than run_command for deletions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the file to delete.' },
      },
      required: ['path'],
    },
  },
};

// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath: string, workspacePath: string): string | null {
  const rel = path.relative(workspacePath, resolvedPath).replace(/\\/g, '/');

  // Block .git directory contents
  if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
    return `SHIELD BLOCKED: Deleting inside .git is forbidden. Path: ${rel}`;
  }
  // Block deletion of workspace root itself
  if (resolvedPath.toLowerCase() === path.resolve(workspacePath).toLowerCase()) {
    return 'SHIELD BLOCKED: Cannot delete the workspace root.';
  }
  return null;
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);

  const shieldError = validateDeletionPath(fp, workspacePath);
  if (shieldError) { return { success: false, output: shieldError }; }

  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}` };
  }
  fs.unlinkSync(fp);
  return { success: true, output: `Deleted: ${args.path}` };
}
