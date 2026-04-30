import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';
import { FileLockManager } from '../../utils/lockfile';
import { checkSyntax } from '../../utils/syntaxValidator';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or fully overwrite a file with the given content. Only use for NEW files — for existing files, always use edit_file to avoid overwriting unrelated code.',
    parameters: {
      type: 'object',
      properties: {
        path:     { type: 'string', description: 'File path relative to workspace root.' },
        content:  { type: 'string', description: 'Complete file content to write.' },
        agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1", "designer-2"). Used by the File Lock Manager to track ownership. Required when running in parallel orchestration mode.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY when intentionally writing a file that may have syntax issues, e.g., a partial template or already-broken file being repaired. Bypasses AST syntax validation.' },
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
  const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';

  // ── AST Syntax Validation (v8.14.0 — Syntax Shield) ─────────────────────────
  // Runs before lock acquisition — no point locking if the content is broken.
  // Skipped for non-TS/JS extensions (markdown, JSON, CSS, etc.) automatically.
  if (!args.healing_mode) {
    const _syntaxCheck = checkSyntax(fp, args.content);
    if (!_syntaxCheck.ok) {
      return {
        success: false,
        output:
          `[SYNTAX ERROR DETECTED] The proposed change breaks the file syntax. Write aborted.\n` +
          `Error details:\n${_syntaxCheck.errors}\n\n` +
          `You MUST review your code block and fix the syntax before retrying.`,
      };
    }
  }
  // ─────────────────────────────────────────────────────────────────────────────

  if (!FileLockManager.acquireLock(fp, agentId)) {
    return {
      success: false,
      output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Tienes prohibido forzar la edición. Por favor, usa la herramienta sleep por 5 segundos o trabaja en otro archivo mientras se libera el cerrojo.`,
    };
  }
  try {
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, args.content, 'utf-8');
    const size = Buffer.byteLength(args.content, 'utf-8');
    return { success: true, output: `Written: ${args.path} (${size} bytes)` };
  } finally {
    FileLockManager.releaseLock(fp, agentId);
  }
}
