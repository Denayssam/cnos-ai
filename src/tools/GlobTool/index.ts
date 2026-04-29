import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'glob',
    description: `Find files in the workspace matching a glob pattern. Use this INSTEAD OF 'ls', 'find', or 'dir' in run_command.
Patterns: ** = any depth, * = any chars (no slash), ? = single char.
Examples:
  "src/**/*.tsx"     → all TSX files under src/
  "**/*.test.ts"     → all test files
  "components/*.jsx" → JSX files in one folder
  "**/*.{ts,tsx}"    → TS and TSX files anywhere`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern relative to workspace root. Use forward slashes.' },
        cwd:     { type: 'string', description: 'Optional subdirectory to search within (relative to workspace root). Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
  },
};

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);

function globToRegex(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*';
      i++;
      if (pattern[i + 1] === '/') { i++; } // consume the slash after **
    } else if (c === '*') {
      r += '[^/]*';
    } else if (c === '?') {
      r += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      r += '\\' + c;
    } else {
      r += c;
    }
  }
  return new RegExp(`^${r}$`, 'i'); // case-insensitive for Windows compat
}

function walkAndMatch(dir: string, root: string, regex: RegExp, results: string[], depth: number): void {
  if (depth > 12 || results.length >= 300) { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    const rel  = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkAndMatch(full, root, regex, results, depth + 1);
    } else if (regex.test(rel)) {
      results.push(rel);
    }
  }
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const pattern = String(args.pattern || '').trim();
  if (!pattern) {
    return { success: false, output: 'CRITICAL ERROR: "pattern" is required. Example: "src/**/*.tsx".' };
  }

  let searchRoot = workspacePath;
  if (typeof args.cwd === 'string' && args.cwd.trim()) {
    searchRoot = path.join(workspacePath, args.cwd.trim());
    if (!fs.existsSync(searchRoot)) {
      return { success: false, output: `Directory not found: "${args.cwd}". Use list_dir('.') to verify the workspace structure.` };
    }
  }

  let regex: RegExp;
  try { regex = globToRegex(pattern); }
  catch { return { success: false, output: `Invalid glob pattern: "${pattern}".` }; }

  const results: string[] = [];
  walkAndMatch(searchRoot, workspacePath, regex, results, 0);

  if (results.length === 0) {
    return {
      success: false,
      output: `No files matched "${pattern}". Try a broader pattern (e.g. "**/*.tsx") or verify the directory with list_dir('.').`,
    };
  }

  const truncated = results.length >= 300;
  return {
    success: true,
    output: `glob("${pattern}"): ${results.length} file(s) found${truncated ? ' — first 300 shown' : ''}:\n\n${(truncated ? results.slice(0, 300) : results).join('\n')}`,
  };
}
