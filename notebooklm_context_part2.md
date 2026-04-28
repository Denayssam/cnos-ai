# 📦 APP MANIFEST
* **App Name:** fluxo-ai
* **Version:** 7.9.11
* **Stack:** Vanilla JS
* **Part:** 2
* **Generated At:** 2026-04-27T17:46:54.445Z

---

### 📁 FILE: `src\tools\ReplaceBlockTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_block',
    description: `Replace a text block in a file using string-based targeting — no line numbers required.
WHEN TO USE: Prefer over replace_lines when the file is long (+300 lines), line numbers keep shifting, or you need to target a semantically unique block (a function body, JSX component, config object).
MANDATORY WORKFLOW: (1) Call read_file to get the current content. (2) Copy the text block you want to replace as target_snippet. (3) Call replace_block with new_content.
MATCHING: Tries exact match first; if whitespace/indentation differs, automatically falls back to fuzzy line-by-line matching that ignores leading/trailing spaces and collapsed internal whitespace.
STRICT RULES:
  • target_snippet must match the file content — same characters, fuzzy on whitespace only.
  • Fails if target_snippet is not found even after fuzzy normalization (content differs — call read_file again).
  • Fails if target_snippet matches more than once (ambiguous — add more surrounding lines to make it unique).
  • Use new_content = "" to delete the block without inserting anything.
  • Does NOT bypass guards unless healing_mode: true is set.`,
    parameters: {
      type: 'object',
      properties: {
        path:           { type: 'string',  description: 'File path relative to workspace root.' },
        target_snippet: { type: 'string',  description: 'The text block to find and replace. Must be unique in the file. Copy from read_file output — whitespace differences are tolerated via fuzzy matching.' },
        new_content:    { type: 'string',  description: 'Text to insert in place of target_snippet. Use empty string "" to delete the block.' },
        healing_mode:   { type: 'boolean', description: 'Set to true ONLY when fixing an already-broken file (syntax error, unbalanced braces, AST corruption). Disables brace-balance and AST guards.' },
      },
      required: ['path', 'target_snippet', 'new_content'],
    },
  },
};

// ─── Fuzzy Matching ───────────────────────────────────────────────────────────

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

type BlockMatch =
  | { kind: 'strict' }
  | { kind: 'fuzzy'; start: number; end: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

/**
 * Locate target_snippet inside fileContent.
 * Fast path: exact string match (1 occurrence).
 * Fuzzy path: line-by-line comparison after whitespace normalization.
 * Returns 'ambiguous' if > 1 strict matches are found (don't fall through to fuzzy).
 */
function findBlock(fileContent: string, snippet: string): BlockMatch {
  // Normalize CRLF in both so mixed line-endings don't break matching
  const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const snip    = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Fast path — exact string match
  const strictOccurrences = content.split(snip).length - 1;
  if (strictOccurrences === 1) { return { kind: 'strict' }; }
  if (strictOccurrences > 1)  { return { kind: 'ambiguous', count: strictOccurrences }; }

  // Fuzzy path — line-by-line normalized comparison
  const fileLines = content.split('\n');
  const rawSnipLines = snip.split('\n');

  // Strip leading/trailing blank-only lines from snippet (LLM multiline string artifacts)
  let si = 0, ei = rawSnipLines.length - 1;
  while (si <= ei && rawSnipLines[si].trim() === '') { si++; }
  while (ei >= si && rawSnipLines[ei].trim() === '') { ei--; }
  const snippetLines = rawSnipLines.slice(si, ei + 1);

  if (snippetLines.length === 0) { return { kind: 'none' }; }

  const snipNorm = snippetLines.map(normalizeLine);
  const n = snippetLines.length;
  const matches: number[] = [];

  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (normalizeLine(fileLines[i + j]) !== snipNorm[j]) {
        continue outer;
      }
    }
    matches.push(i);
  }

  if (matches.length === 0) { return { kind: 'none' }; }
  if (matches.length > 1)  { return { kind: 'ambiguous', count: matches.length }; }

  return { kind: 'fuzzy', start: matches[0], end: matches[0] + n - 1 };
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }
  if (typeof args.target_snippet !== 'string' || args.target_snippet === '') {
    return { success: false, output: 'CRITICAL ERROR: target_snippet must be a non-empty string. Copy the exact text block from read_file output.' };
  }
  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string. Use empty string "" to delete the block.' };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findBlock(original, args.target_snippet);

  if (match.kind === 'none') {
    return {
      success: false,
      output: `MATCH ERROR: target_snippet not found in ${args.path} — exact match failed and fuzzy whitespace-normalization also found no match.\n` +
              `This means the snippet content itself differs from the file (not just whitespace/indentation).\n` +
              `ACTION REQUIRED: Call read_file again to get current content, then re-copy the target block verbatim. Do not paraphrase or shorten.`,
    };
  }

  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: target_snippet appears ${match.count} times in ${args.path}.\n` +
              `Your snippet is too generic. Expand it — add the function signature above or the closing brace below to make the block unique.`,
    };
  }

  // Build updated file content
  let updated: string;
  let removedPreviewText: string;
  let removedLineCount: number;
  let matchStartLine: number;
  let matchEndLine: number;

  if (match.kind === 'strict') {
    // Exact replacement — preserve all original formatting outside the matched block
    const snipNormalized = args.target_snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
                      .replace(snipNormalized, args.new_content.replace(/\n$/, ''));

    const before = original.replace(/\r\n/g, '\n').indexOf(snipNormalized);
    matchStartLine = original.slice(0, before).split('\n').length;
    removedLineCount = snipNormalized.split('\n').length;
    matchEndLine = matchStartLine + removedLineCount - 1;
    removedPreviewText = snipNormalized.length > 300 ? snipNormalized.slice(0, 300) + '\n…(truncated)' : snipNormalized;
  } else {
    // Fuzzy replacement — line-based reconstruction
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = args.new_content === '' ? [] : args.new_content.replace(/\n$/, '').split('\n');
    const resultLines = [
      ...fileLines.slice(0, match.start),
      ...newLines,
      ...fileLines.slice(match.end + 1),
    ];
    updated = resultLines.join('\n');

    matchStartLine = match.start + 1;
    matchEndLine = match.end + 1;
    removedLineCount = match.end - match.start + 1;
    const removedText = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreviewText = removedText.length > 300 ? removedText.slice(0, 300) + '\n…(truncated)' : removedText;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your target_snippet and new_content.' };
  }

  // ── Guards (skipped in healing_mode) ─────────────────────────────────────
  if (!args.healing_mode) {
    const JS_EXTENSIONS  = ['.ts', '.tsx', '.js', '.jsx'];
    const JSX_EXTENSIONS = ['.tsx', '.jsx'];
    const fileExt        = path.extname(fp).toLowerCase();

    if (JS_EXTENSIONS.includes(fileExt)) {
      const openCount  = (updated.match(/\{/g) || []).length;
      const closeCount = (updated.match(/\}/g) || []).length;
      if (openCount !== closeCount) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: Llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado.\n` +
                  `ANTI-PANIC DIRECTIVE: No reenvíes el mismo bloque. Divide la inserción.\n` +
                  `Si estás arreglando un archivo YA corrupto, usa "healing_mode: true".`,
        };
      }
    }

    if (JSX_EXTENSIONS.includes(fileExt)) {
      const jsxBalance = (code: string): number => {
        const opens     = (code.match(/<[A-Za-z]/g) || []).length;
        const closes    = (code.match(/<\/[A-Za-z]/g) || []).length;
        const selfClose = (code.match(/\/>/g) || []).length;
        return opens - closes - selfClose;
      };
      if (jsxBalance(original) !== jsxBalance(updated)) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado.\n` +
                  `ESTRATEGIA: Asegúrate de incluir el bloque JSX completo desde su apertura hasta su cierre en target_snippet.\n` +
                  `Si estás arreglando un archivo YA corrupto, usa "healing_mode: true".`,
        };
      }
    }
  }

  // Auto-backup before write
  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${timestamp}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const matchNote = match.kind === 'fuzzy'
    ? ` [fuzzy match: whitespace-normalized, lines ${matchStartLine}–${matchEndLine}]`
    : ` [exact match, lines ${matchStartLine}–${matchEndLine}]`;

  return {
    success: true,
    output: `replace_block: ${args.path} — 1 block replaced (${removedLineCount} line${removedLineCount !== 1 ? 's' : ''}).${matchNote}\n\nBLOCK REMOVED:\n${removedPreviewText}\n\nEDICIÓN EXITOSA — Verifica que el bloque eliminado es el correcto. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
  };
}

```

### 📁 FILE: `src\tools\ReplaceLinesTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'replace_lines',
    description: `Replace an exact range of lines in a file using coordinate-based targeting.
MANDATORY WORKFLOW: (1) Call read_file to get current line numbers. (2) Identify start_line and end_line for the block to replace. (3) Call replace_lines with new_content.
CRITICAL: Line numbers shift after every edit — always call read_file again before a subsequent replace_lines on the same file.
Use new_content = "" to delete the line range without inserting anything.
NEVER skip read_file — guessing line numbers without reading first is PROHIBITED.
TO INSERT NEW LINES WITHOUT DELETING: Set start_line and end_line to the exact same number (the line you want to target). In new_content, write the original text of that line, add a newline character (\\n), and then write your new code.`,
    parameters: {
      type: 'object',
      properties: {
        path:        { type: 'string', description: 'File path relative to workspace root.' },
        start_line:  { type: 'number', description: '1-based line number where the replacement begins (inclusive). Must come from a preceding read_file call.' },
        end_line:    { type: 'number', description: '1-based line number where the replacement ends (inclusive). Must be >= start_line.' },
        new_content: { type: 'string', description: 'Text to insert in place of the removed lines. Pass an empty string "" to delete the range. Do NOT add a trailing newline — the engine handles line endings.' },
        healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are fixing a syntax error, unbalanced brace, or AST corruption. This temporarily disables the syntax and AST guards to allow surgical fixes on already broken files.' },
      },
      required: ['path', 'start_line', 'end_line', 'new_content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }

  const startLine = Number(args.start_line);
  const endLine   = Number(args.end_line);

  if (!Number.isInteger(startLine) || startLine < 1) {
    return { success: false, output: `CRITICAL ERROR: start_line must be a positive integer >= 1 (received: ${args.start_line}). Call read_file first to get correct line numbers.` };
  }
  if (!Number.isInteger(endLine) || endLine < startLine) {
    return { success: false, output: `CRITICAL ERROR: end_line (${endLine}) must be an integer >= start_line (${startLine}). Call read_file to verify current line numbers.` };
  }
  if (typeof args.new_content !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: new_content must be a string. Use an empty string "" to delete lines without inserting anything.' };
  }

  const original   = fs.readFileSync(fp, 'utf-8');

  // Black Box auto-backup — save original before any modification
  try {
    const backupDir  = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp  = new Date().toISOString().replace(/[:.]/g, '-');
    const backupName = `${path.basename(fp)}_${timestamp}.bak`;
    fs.writeFileSync(path.join(backupDir, backupName), original, 'utf-8');
  } catch {
    // Backup failure is non-fatal — edit proceeds regardless
  }

  const lines      = original.split('\n');
  const totalLines = lines.length;

  if (startLine > totalLines) {
    return { success: false, output: `CRITICAL ERROR: start_line (${startLine}) exceeds file length (${totalLines} lines). Call read_file to get updated line numbers.` };
  }

  const clampedEnd  = Math.min(endLine, totalLines);
  const clampNote   = endLine > totalLines ? ` (end_line ${endLine} clamped to file length ${totalLines})` : '';

  // Split new_content into lines. Strip trailing \n to avoid phantom blank line.
  const newLines = args.new_content === '' ? [] : args.new_content.replace(/\n$/, '').split('\n');

  const resultLines = [
    ...lines.slice(0, startLine - 1),
    ...newLines,
    ...lines.slice(clampedEnd),
  ];

  const updated = resultLines.join('\n');

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file. Verify your line range and new_content.' };
  }

  const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
  const fileExt = path.extname(fp).toLowerCase();

  if (!args.healing_mode) {
    // Deterministic brace-balance guard — runs before writing to disk
    if (JS_EXTENSIONS.includes(fileExt)) {
      const openCount  = (updated.match(/\{/g) || []).length;
      const closeCount = (updated.match(/\}/g) || []).length;
      if (openCount !== closeCount) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: Tu 'new_content' tiene llaves desequilibradas (${openCount} "{" vs ${closeCount} "}"). El archivo NO fue modificado.\nANTI-PANIC DIRECTIVE: ESTÁ ESTRICTAMENTE PROHIBIDO enviar el mismo código de nuevo. Tu bloque es demasiado grande.\nNUEVA ESTRATEGIA OBLIGATORIA: Divide la inserción. Primero inserta solo el esqueleto vacío del componente o función. En la SIGUIENTE iteración, rellena el contenido. No intentes inyectar más de 20 líneas de lógica de una sola vez.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
        };
      }
    }

    // JSX/AST integrity guard — prevents orphaned or crossed tags in React files
    const JSX_EXTENSIONS_AST = ['.tsx', '.jsx'];
    if (JSX_EXTENSIONS_AST.includes(fileExt)) {
      const jsxBalance = (code: string): number => {
        const opens     = (code.match(/<[A-Za-z]/g) || []).length;
        const closes    = (code.match(/<\/[A-Za-z]/g) || []).length;
        const selfClose = (code.match(/\/>/g) || []).length;
        return opens - closes - selfClose;
      };
      const origBalance    = jsxBalance(original);
      const updatedBalance = jsxBalance(updated);
      if (origBalance !== updatedBalance) {
        return {
          success: false,
          output: `CRITICAL SYNTAX ERROR: AST/JSX Corruption detected. Etiquetas HTML/JSX desbalanceadas. El archivo NO fue modificado. ESTRATEGIA: Selecciona el bloque JSX completo desde su apertura hasta su cierre.\nSi estás intentando arreglar un archivo YA corrupto, usa "healing_mode: true" para desactivar los guards.`,
        };
      }
    }
  }

  const removedLines = lines.slice(startLine - 1, clampedEnd);
  const linesRemoved = clampedEnd - startLine + 1;
  const linesAdded   = newLines.length;

  // Anti-Mass-Deletion guard — blocks accidental truncation before the file is written
  if (linesRemoved > 50 && linesAdded < linesRemoved * 0.2) {
    return {
      success: false,
      output: `CRITICAL WARNING: ANTI-MASS-DELETION GUARD. Estás intentando eliminar ${linesRemoved} líneas pero solo insertando ${linesAdded}. ` +
              `Esto suele ser un error de truncamiento del modelo. Si realmente deseas hacer este borrado masivo, ` +
              `el motor requiere que lo dividas en bloques más pequeños o confirmes la acción. ` +
              `(Nota: la herramienta falla, no escribe el archivo, y obliga al agente a reconsiderar).`,
    };
  }

  fs.writeFileSync(fp, updated, 'utf-8');

  // Build a compact preview of removed content for auto-verification
  const removedText  = removedLines.join('\n');
  const removedPreview = removedText.length > 300
    ? removedText.slice(0, 300) + '\n…(truncated)'
    : removedText;

  return {
    success: true,
    output: `replace_lines: ${args.path} — replaced lines ${startLine}–${clampedEnd} (${linesRemoved} line${linesRemoved !== 1 ? 's' : ''} → ${linesAdded} line${linesAdded !== 1 ? 's' : ''})${clampNote}.\n\nLINES REMOVED:\n${removedPreview}\n\nEDICIÓN EXITOSA — Verifica que las líneas eliminadas son las correctas. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
  };
}

```

### 📁 FILE: `src\tools\RunCommandTool\index.ts`
```typescript
import { execSync } from 'child_process';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description: 'Execute a shell command in the workspace. On Windows, always quote paths containing spaces.',
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

  const BLOCKED = [/rm\s+-rf\s+[/\\~]/, /format\s+[a-z]:/, /del\s+\/[fs]/i, /mkfs/, /dd\s+if=/];
  if (BLOCKED.some(b => b.test(cmd))) {
    return { success: false, output: `Blocked dangerous command: ${cmd}` };
  }

  // Block persistent dev-server processes — they hang spawnSync and cause ETIMEDOUT loops.
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
      output: `CRITICAL: Persistent servers like "npm run dev" hang the swarm. DIRECTIVE: Do not panic. Immediately use "npm run build" instead to verify your changes and continue the workflow.`,
    };
  }

  const output = execSync(cmd, {
    cwd: workspacePath,
    encoding: 'utf-8',
    timeout,
    maxBuffer: 1024 * 1024 * 4,
  });
  return { success: true, output: output || '(command completed with no output)' };
}

```

### 📁 FILE: `src\tools\SearchImagesTool\index.ts`
```typescript
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_images',
    description: 'Get free stock image URLs for a given subject from Lorem Picsum.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Subject or keywords for the image search.' },
        count: { type: 'number', description: 'Number of URLs to return (1-10, default 5).' },
      },
      required: ['query'],
    },
  },
};

export function execute(args: Record<string, any>, _workspacePath: string): ToolResult {
  const query = encodeURIComponent(String(args.query || 'nature'));
  const count = Math.min(Math.max(Number(args.count) || 5, 1), 10);
  const urls: string[] = [];
  for (let i = 1; i <= count; i++) {
    urls.push(`https://picsum.photos/seed/${query}${i}/1400/900`);
  }
  return {
    success: true,
    output: [
      `Free image URLs for "${args.query}":`,
      ...urls.map((u, i) => `${i + 1}. ${u}`),
      '',
      'Usage: <img src="URL_HERE" alt="description" />',
    ].join('\n'),
  };
}

```

### 📁 FILE: `src\tools\SearchInFilesTool\index.ts`
```typescript
import { NativeTool, ToolResult, safePath, searchRecursive } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_in_files',
    description: 'Search for a text pattern across workspace files. Returns matching file:line results.',
    parameters: {
      type: 'object',
      properties: {
        pattern:   { type: 'string', description: 'The text pattern to search for (case-insensitive).' },
        directory: { type: 'string', description: 'Subdirectory to restrict the search. Defaults to workspace root.' },
      },
      required: ['pattern'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const searchRoot = safePath(workspacePath, args.directory || '.');
  const results: string[] = [];
  searchRecursive(searchRoot, workspacePath, String(args.pattern || ''), results, 0);
  if (results.length === 0) {
    return { success: true, output: 'No matches found.' };
  }
  return { success: true, output: results.slice(0, 60).join('\n') };
}

```

### 📁 FILE: `src\tools\SearchReplaceTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_and_replace',
    description: `Replace a specific block of code in a file using contextual search — no line numbers required.
PREFERRED EDITING TOOL: Use this instead of replace_lines or replace_block for all code edits.
STRATEGY: In 'search_snippet', include enough context (2–3 lines before and after the target change) to ensure the match is unique in the file. Minor indentation differences are tolerated via fuzzy whitespace-normalization.
WORKFLOW:
  1. Call read_file to get the current file content.
  2. Copy the exact block you want to replace as search_snippet (include surrounding context for uniqueness).
  3. Call search_and_replace — the engine applies the change in the VS Code editor (file stays unsaved for review).
  4. After the call, tell the user: "Cambio aplicado en el editor. Revísalo y presiona Ctrl+S para guardar."
RULES:
  • search_snippet must match a unique block — add more surrounding lines if ambiguous.
  • No AST guards: the edit appears in VS Code for visual review before saving.
  • Use replace_snippet = "" to delete a block.
  • Do NOT call further edit tools on the same file before the user confirms with Ctrl+S.`,
    parameters: {
      type: 'object',
      properties: {
        path:            { type: 'string', description: 'File path relative to workspace root.' },
        search_snippet:  { type: 'string', description: 'The EXACT code currently in the file that you want to replace. Include 2–3 surrounding lines of context to guarantee uniqueness.' },
        replace_snippet: { type: 'string', description: 'The NEW code that will replace search_snippet. Use empty string "" to delete the block.' },
      },
      required: ['path', 'search_snippet', 'replace_snippet'],
    },
  },
};

// ─── Fuzzy Matching (mirrors ReplaceBlockTool logic) ─────────────────────────

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

type MatchResult =
  | { kind: 'strict' }
  | { kind: 'fuzzy'; start: number; end: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number };

function findMatch(fileContent: string, snippet: string): MatchResult {
  const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const snip    = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const strictCount = content.split(snip).length - 1;
  if (strictCount === 1) { return { kind: 'strict' }; }
  if (strictCount > 1)  { return { kind: 'ambiguous', count: strictCount }; }

  // Fuzzy: line-by-line normalized comparison
  const fileLines = content.split('\n');
  const rawSnip = snip.split('\n');

  let si = 0, ei = rawSnip.length - 1;
  while (si <= ei && rawSnip[si].trim() === '') { si++; }
  while (ei >= si && rawSnip[ei].trim() === '') { ei--; }
  const snippetLines = rawSnip.slice(si, ei + 1);
  if (snippetLines.length === 0) { return { kind: 'none' }; }

  const snipNorm = snippetLines.map(normalizeLine);
  const n = snippetLines.length;
  const matches: number[] = [];

  outer: for (let i = 0; i <= fileLines.length - n; i++) {
    for (let j = 0; j < n; j++) {
      if (normalizeLine(fileLines[i + j]) !== snipNorm[j]) { continue outer; }
    }
    matches.push(i);
  }

  if (matches.length === 0) { return { kind: 'none' }; }
  if (matches.length > 1)  { return { kind: 'ambiguous', count: matches.length }; }
  return { kind: 'fuzzy', start: matches[0], end: matches[0] + n - 1 };
}

// ─── Diff Builder ─────────────────────────────────────────────────────────────

const MAX_DIFF_LINES = 25;

function buildDiffBlock(search: string, replace: string): string {
  const norm = (s: string) => s.replace(/\r\n/g, '\n').trimEnd();
  const remLines = norm(search).split('\n');
  const addLines = replace === '' ? [] : norm(replace).split('\n');

  const remSection = remLines.length > MAX_DIFF_LINES
    ? [...remLines.slice(0, MAX_DIFF_LINES).map(l => `- ${l}`), `- … (+${remLines.length - MAX_DIFF_LINES} lines not shown)`]
    : remLines.map(l => `- ${l}`);
  const addSection = addLines.length > MAX_DIFF_LINES
    ? [...addLines.slice(0, MAX_DIFF_LINES).map(l => `+ ${l}`), `+ … (+${addLines.length - MAX_DIFF_LINES} lines not shown)`]
    : addLines.map(l => `+ ${l}`);

  return '```diff\n' + [...remSection, ...addSection].join('\n') + '\n```';
}

// ─── Disk-based fallback executor (used when VS Code native edit is unavailable) ─

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  const fp = safePath(workspacePath, args.path);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${args.path}. Use list_dir to verify the path.` };
  }
  if (typeof args.search_snippet !== 'string' || args.search_snippet === '') {
    return { success: false, output: 'CRITICAL ERROR: search_snippet must be a non-empty string.' };
  }
  if (typeof args.replace_snippet !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: replace_snippet must be a string. Use "" to delete.' };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findMatch(original, args.search_snippet);

  if (match.kind === 'none') {
    return {
      success: false,
      output: `MATCH ERROR: search_snippet not found in ${args.path} — exact and fuzzy matches both failed.\n` +
              `Call read_file to get current content and re-copy the exact block verbatim.`,
    };
  }
  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: search_snippet appears ${match.count} times in ${args.path}.\n` +
              `Expand the snippet — add more surrounding lines to make the block unique.`,
    };
  }

  let updated: string;
  let removedPreview: string;
  let removedLines: number;
  let startLine: number;

  if (match.kind === 'strict') {
    const snip = args.search_snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(snip, args.replace_snippet.replace(/\n$/, ''));
    const before = original.replace(/\r\n/g, '\n').indexOf(snip);
    startLine = original.slice(0, before).split('\n').length;
    removedLines = snip.split('\n').length;
    removedPreview = snip.length > 300 ? snip.slice(0, 300) + '\n…(truncated)' : snip;
  } else {
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = args.replace_snippet === '' ? [] : args.replace_snippet.replace(/\n$/, '').split('\n');
    updated = [...fileLines.slice(0, match.start), ...newLines, ...fileLines.slice(match.end + 1)].join('\n');
    startLine = match.start + 1;
    removedLines = match.end - match.start + 1;
    const removed = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreview = removed.length > 300 ? removed.slice(0, 300) + '\n…(truncated)' : removed;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file.' };
  }

  // Auto-backup
  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${ts}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const matchNote = match.kind === 'fuzzy' ? ` [fuzzy match, line ${startLine}]` : ` [exact match, line ${startLine}]`;
  const diffBlock = buildDiffBlock(args.search_snippet, args.replace_snippet);
  return {
    success: true,
    output: `${diffBlock}\n\n**${args.path}** — ${removedLines} line${removedLines !== 1 ? 's' : ''} replaced.${matchNote}\n\nCambio aplicado en el editor. Revisa el Diff arriba y presiona Ctrl+S en el archivo para guardar.\n\nEDICIÓN EXITOSA — Si la tarea no está completa, llama la siguiente herramienta.`,
  };
}

```

### 📁 FILE: `src\tools\shared.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';

// ─── Shared Types ─────────────────────────────────────────────────────────────

export interface ToolResult {
  success: boolean;
  output: string;
}

export interface NativeTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

export function safePath(workspacePath: string, p: string): string {
  if (!p) { throw new Error('Path is required'); }
  const resolved = path.resolve(workspacePath, p);
  if (!resolved.toLowerCase().startsWith(path.resolve(workspacePath).toLowerCase())) {
    throw new Error(`Path traversal blocked: ${p}`);
  }
  return resolved;
}

export function searchRecursive(
  dir: string,
  root: string,
  pattern: string,
  results: string[],
  depth: number
): void {
  if (depth > 6 || results.length > 100) { return; }
  const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '__pycache__']);

  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

  for (const entry of entries) {
    if (SKIP.has(entry.name)) { continue; }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      searchRecursive(full, root, pattern, results, depth + 1);
    } else {
      try {
        const content = fs.readFileSync(full, 'utf-8');
        const lowerContent = content.toLowerCase();
        const lowerPattern = pattern.toLowerCase();
        if (lowerContent.includes(lowerPattern)) {
          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (line.toLowerCase().includes(lowerPattern)) {
              results.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 120)}`);
            }
          });
        }
      } catch { /* binary file */ }
    }
  }
}

```

### 📁 FILE: `src\tools\UpdateMemoryTool\index.ts`
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult } from '../shared';

const MEMORY_PATH = '.fluxo/memory.md';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'update_memory',
    description:
      'Create or overwrite the workspace memory file (.fluxo/memory.md). ' +
      'Use this tool when the user explicitly asks you to "remember" a rule, preference, or convention, ' +
      'OR when you and the user agree on an important architectural decision that should persist across sessions. ' +
      'Always include the full desired memory content — this overwrites the file completely. ' +
      'Read the existing memory first (if any) so you can merge old rules with new ones before writing.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description:
            'Full markdown content for .fluxo/memory.md. Use headings (##) to organize rules by category. ' +
            'Example sections: ## Coding Conventions, ## Architecture Decisions, ## User Preferences.',
        },
      },
      required: ['content'],
    },
  },
};

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
  if (typeof args.content !== 'string' || args.content.trim() === '') {
    return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
  }
  const memoryFilePath = path.join(workspacePath, MEMORY_PATH);
  fs.mkdirSync(path.dirname(memoryFilePath), { recursive: true });
  fs.writeFileSync(memoryFilePath, args.content, 'utf-8');
  const size = Buffer.byteLength(args.content, 'utf-8');
  return {
    success: true,
    output: `Workspace memory updated: ${MEMORY_PATH} (${size} bytes). Rules will be injected into all agents on the next session.`,
  };
}

```

### 📁 FILE: `tsconfig.json`
```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "outDir": "./out",
    "rootDir": "./src",
    "sourceMap": true,
    "strict": true,
    "lib": ["ES2020"],
    "types": ["node"],
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "out", "media"]
}

```

