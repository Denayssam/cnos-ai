import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'grep',
    description: `Search for a string or regex pattern across project files. Use this INSTEAD OF 'grep', 'findstr', or 'rg' in run_command.
Returns: file_path:line_number: matching_line for every match.
WHEN TO USE: Finding where a function is called, locating imports, tracking variable usage across the project.
Examples:
  pattern: "handleSubmit"         → finds all usages of handleSubmit
  pattern: "import.*useAuth"      → finds all useAuth import lines
  pattern: "useState\\("          → finds all useState hooks`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Search string or JavaScript regex pattern. Strings are matched literally; regex metacharacters are supported (e.g. "import.*from", "const.*=.*useState").',
        },
        path_filter: {
          type: 'string',
          description: 'Optional glob pattern to limit which files to search (e.g. "src/**/*.ts", "**/*.jsx"). Omit to search all files.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the match is case-sensitive. Defaults to false.',
        },
      },
      required: ['pattern'],
    },
  },
};

const SKIP_DIRS  = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__', '.fluxo']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.pdf', '.zip', '.gz', '.tar', '.bak', '.vsix']);

// Inline glob-to-regex so GrepTool has no shared dependency on GlobTool
function globToRegex(pattern: string): RegExp {
  let r = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*' && pattern[i + 1] === '*') {
      r += '.*'; i++;
      if (pattern[i + 1] === '/') { i++; }
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
  return new RegExp(`^${r}$`, 'i');
}

interface GrepMatch { file: string; line: number; content: string; }

function searchFile(filePath: string, relPath: string, rx: RegExp, results: GrepMatch[]): void {
  if (BINARY_EXT.has(path.extname(filePath).toLowerCase())) { return; }
  let text: string;
  try { text = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && results.length < 500; i++) {
    if (rx.test(lines[i])) {
      results.push({ file: relPath, line: i + 1, content: lines[i].trim().slice(0, 200) });
    }
  }
}

function walkAndGrep(
  dir: string, root: string,
  fileFilter: RegExp | null, searchRx: RegExp,
  results: GrepMatch[], depth: number
): void {
  if (depth > 12 || results.length >= 500) { return; }
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    const rel  = path.relative(root, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      walkAndGrep(full, root, fileFilter, searchRx, results, depth + 1);
    } else if (!fileFilter || fileFilter.test(rel)) {
      searchFile(full, rel, searchRx, results);
    }
  }
}

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const patternStr = String(args.pattern || '').trim();
  if (!patternStr) {
    return { success: false, output: 'CRITICAL ERROR: "pattern" is required.' };
  }

  const flags = args.case_sensitive === true ? '' : 'i';
  let searchRx: RegExp;
  try {
    searchRx = new RegExp(patternStr, flags);
  } catch {
    // Not valid regex — escape and treat as literal string
    const escaped = patternStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    searchRx = new RegExp(escaped, flags);
  }

  let fileFilter: RegExp | null = null;
  if (typeof args.path_filter === 'string' && args.path_filter.trim()) {
    try { fileFilter = globToRegex(args.path_filter.trim()); } catch { /* ignore bad filter */ }
  }

  const results: GrepMatch[] = [];
  walkAndGrep(workspacePath, workspacePath, fileFilter, searchRx, results, 0);

  if (results.length === 0) {
    return {
      success: false,
      output: `No matches for "${patternStr}"${args.path_filter ? ` in "${args.path_filter}"` : ''}. Try a broader pattern or remove the path_filter.`,
    };
  }

  const truncated = results.length >= 500;
  const lines = (truncated ? results.slice(0, 500) : results)
    .map(r => `${r.file}:${r.line}: ${r.content}`)
    .join('\n');

  return {
    success: true,
    output: `grep("${patternStr}"): ${results.length} match(es)${truncated ? ' — first 500 shown' : ''}:\n\n${lines}`,
  };
}
