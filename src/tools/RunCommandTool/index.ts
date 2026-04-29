import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      'Execute a shell command in the workspace directory. ' +
      'On Windows use Windows commands (dir, del, move, copy) — never Linux commands (ls, rm -rf, mv, cp). ' +
      'Always quote paths that contain spaces. ' +
      'WORKTREE NOTE: If a Git Worktree is active, do NOT use "cd" to navigate into it. ' +
      'All native tools (read_file, run_command, replace_block) already operate on the correct ' +
      'workspace context automatically — attempting "cd <worktree-path>" will break the working directory.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute.' },
      },
      required: ['command'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const cmd = args.command as string;
  const timeout = (args.timeout as number) || 30_000;

  // ── Destructive command block ────────────────────────────────────────────────
  const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
  if (BLOCKED.some(b => b.test(cmd))) {
    return { success: false, output: `Blocked dangerous command: ${cmd}` };
  }

  // ── Anti-Hacker Shield: block CLI direct file-reading ───────────────────────
  // Only the FIRST segment (before any pipe) is checked — this allows legitimate
  // pipeline filtering like "npm run build | head -50" or "tsc 2>&1 | grep error".
  // The filter in those cases processes STDIN (stdout from the prior command),
  // not a file on disk. Direct usage as first command IS blocked.
  //
  // BLOCKED: grep "error" src/file.ts  |  head -100 src/file.ts  |  cat file.js
  // ALLOWED: npm run build | grep error |  tsc | head -50         |  git log | tail -20
  const CLI_FILE_READ = /^\s*(cat|tail|head|less|more|type|Get-Content|findstr|grep|wc)\b/i;
  const cmdSegments = cmd.split(/\s*[|;&]+\s*/);
  const firstSegment = cmdSegments[0] ?? '';
  if (CLI_FILE_READ.test(firstSegment)) {
    return {
      success: false,
      output:
        'SYSTEM ERROR: Intento de lectura de archivo por terminal bloqueado. ' +
        'NO uses comandos de consola (cat, type, grep, head, etc.) para leer código directamente. ' +
        'Usa read_file o search_in_files. ' +
        'Para filtrar OUTPUT de otro comando, usa el pipe: "npm run build | grep error" es VÁLIDO.',
    };
  }

  // ── Evasion Block: prevent sed, awk, node -e, perl, python -c ───────────────
  const EVASION_TOOLS = /^\s*(sed|awk|node\s+-e|perl|python\s+-c)\b/i;
  if (cmdSegments.some(seg => EVASION_TOOLS.test(seg))) {
    return {
      success: false,
      output:
        'SYSTEM SECURITY ALERT: Intento de evasión detectado. Tienes PROHIBIDO usar ' +
        'herramientas de CLI (sed, awk, node -e, etc.) para manipular código. ' +
        'Usa read_file y replace_block o replace_symbol inmediatamente.',
    };
  }

  // ── Persistent dev-server block ──────────────────────────────────────────────
  const PERSISTENT_PATTERNS = [
    /\bnpm\s+run\s+dev\b/,
    /\bnpm\s+start\b/,
    /\bnpm\s+run\s+start\b/,
    /\byarn\s+dev\b/,
    /\byarn\s+start\b/,
    /\bpnpm\s+dev\b/,
    /\bpnpm\s+start\b/,
    /\bnodemon\b/,
    /\bnext\s+dev\b/,
    /\bvite\b(?!\s+build)/,
    /\bwebpack\s+--watch\b/,
    /\bng\s+serve\b/,
  ];
  if (PERSISTENT_PATTERNS.some(p => p.test(cmd))) {
    return {
      success: false,
      output:
        'CRITICAL: Persistent servers like "npm run dev" hang the swarm. ' +
        'DIRECTIVE: Do not panic. Use "npm run build" instead to verify your changes and continue.',
    };
  }

  // ── Execute ──────────────────────────────────────────────────────────────────
  try {
    const output = execSync(cmd, {
      cwd: workspacePath,
      encoding: 'utf-8',
      timeout,
      maxBuffer: 1024 * 1024 * 4,
    });
    return { success: true, output: output || '(command completed with no output)' };
  } catch (err: any) {
    // execSync throws on non-zero exit — capture both stdout and stderr from the error object
    const stdout = err.stdout ? String(err.stdout).trim() : '';
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    const combined = [stdout, stderr].filter(Boolean).join('\n').trim();
    return { success: false, output: combined || err.message || 'Command failed with no output' };
  }
}
