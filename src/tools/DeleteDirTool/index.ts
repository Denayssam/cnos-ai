import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'delete_dir',
    description: 'Delete a directory and all its contents recursively. Safer than run_command for deletions.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to the directory to delete.' },
      },
      required: ['path'],
    },
  },
};

// ── Shield Patch (v8.10.0) — critical path validation ─────────────────────────
function validateDeletionPath(resolvedPath: string, workspacePath: string): string | null {
  const resolvedWs = path.resolve(workspacePath);
  const rel = path.relative(resolvedWs, resolvedPath).replace(/\\/g, '/');

  // Block workspace root itself
  if (resolvedPath.toLowerCase() === resolvedWs.toLowerCase()) {
    return 'SHIELD BLOCKED: Cannot delete the workspace root directory.';
  }
  // Block .git directory (whole tree or any subdirectory inside it)
  if (rel === '.git' || rel.startsWith('.git/') || rel.startsWith('.git\\')) {
    return `SHIELD BLOCKED: Deleting the .git directory is forbidden. Path: ${rel}`;
  }
  // Block node_modules only when path IS node_modules at the workspace root
  // (allow sub-package deletions inside nested node_modules)
  if (rel === 'node_modules') {
    return 'SHIELD BLOCKED: Deleting node_modules via agent is forbidden. Run "npm install" to restore it.';
  }
  return null;
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const dp = safePath(workspacePath, args.path);

  const shieldError = validateDeletionPath(dp, workspacePath);
  if (shieldError) { return { success: false, output: shieldError }; }

  if (!fs.existsSync(dp)) {
    return { success: false, output: `Directory not found: ${args.path}` };
  }
  fs.rmSync(dp, { recursive: true, force: true });
  return { success: true, output: `Directory and contents deleted: ${args.path}` };
}
