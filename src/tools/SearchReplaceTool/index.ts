import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_and_replace',
    description: `Replace a specific block of code in a file using contextual search — no line numbers required.
PREFERRED EDITING TOOL: Use this for small, surgical edits guided by the Verbatim Rule.

⚠️ SCOPE LIMIT (v8.16.18): If you need to inject a massive new React component, DO NOT use this tool. Use insert_lines instead.

⚠️ UDIFF-STYLE PRECISION (v8.17.3 — read this before every call):
  Guessing whitespace IS THE #1 cause of MATCH ERRORS in this tool. Tabs vs.
  spaces, trailing whitespace, CRLF vs. LF, indentation drift — all of them
  silently break the match even when the code "looks right" in your context.
  HARD RULE:
    1. ALWAYS call read_file (or get_repo_map → read_file) immediately before
       this tool to capture the file in its current state. Reading from memory
       of a previous turn is NOT allowed — files mutate.
    2. Copy the search_snippet VERBATIM from the read_file output, character
       for character, including every space and tab. Do NOT retype.
    3. Format the replace_snippet like a unified diff hunk: keep the SAME
       indentation level as the search_snippet's leading whitespace, preserve
       the SAME line-ending style, and leave NO trailing whitespace on new
       lines you add.
    4. If the previous call returned MATCH ERROR, do NOT retry with a guessed
       snippet — re-read the file and copy verbatim again. Your guess is wrong.

STRATEGY: In 'search_snippet', include enough context (2–3 lines before and after the target change) to ensure the match is unique in the file. Minor indentation differences are tolerated via fuzzy whitespace-normalization, but the fuzzy fallback is a safety net — it is NOT a license to improvise indentation.
WORKFLOW:
  1. Call read_file to get the current file content (MANDATORY — see UDIFF rule above).
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
  // ── v8.31.0/v8.32.0: Tool Aliasing — tolerate LLM arg-name slips under stress ─
  // Tier-1 models (Gemini/Claude) frequently emit `file_path` instead of `path`,
  // `old_code`/`new_code` instead of the canonical `*_snippet`, and Gemini 2.5
  // Pro additionally hallucinates `search_pattern`/`replace_pattern` based on
  // Python regex APIs. We normalize at the boundary so the rest of the function
  // operates on a single shape.
  const targetPath: unknown = args.path ?? args.file_path ?? args.filepath;
  const searchTarget: unknown =
    args.search_snippet ?? args.search ?? args.old_code ?? args.search_pattern;
  const replaceTarget: unknown =
    args.replace_snippet ?? args.replace ?? args.new_code ?? args.replace_pattern ?? '';
  // ─────────────────────────────────────────────────────────────────────────────

  if (typeof targetPath !== 'string' || targetPath === '') {
    return { success: false, output: 'CRITICAL ERROR: "path" is required (alias accepted: file_path, filepath).' };
  }
  if (typeof searchTarget !== 'string' || searchTarget === '') {
    return { success: false, output: 'CRITICAL ERROR: search_snippet must be a non-empty string (aliases accepted: search, old_code, search_pattern).' };
  }
  if (typeof replaceTarget !== 'string') {
    return { success: false, output: 'CRITICAL ERROR: replace_snippet must be a string (aliases accepted: replace, new_code, replace_pattern). Use "" to delete.' };
  }

  const fp = safePath(workspacePath, targetPath);
  if (!fs.existsSync(fp)) {
    return { success: false, output: `File not found: ${targetPath}. Use list_dir to verify the path.` };
  }

  const original = fs.readFileSync(fp, 'utf-8');
  const match = findMatch(original, searchTarget);

  if (match.kind === 'none') {
    return {
      success: false,
      output: `ERROR: El bloque exacto no se encontró (posible problema de indentación o archivo corrupto). Tienes PROHIBIDO volver a intentar search_and_replace en esta zona con un snippet adivinado. DEBES llamar read_file primero para copiar el texto VERBATIM, o usar insert_lines si vas a inyectar un bloque nuevo masivo.`,
    };
  }
  if (match.kind === 'ambiguous') {
    return {
      success: false,
      output: `AMBIGUOUS MATCH: search_snippet appears ${match.count} times in ${targetPath}.\n` +
              `Expand the snippet — add more surrounding lines to make the block unique.`,
    };
  }

  let updated: string;
  let removedPreview: string;
  let removedLines: number;
  let startLine: number;

  if (match.kind === 'strict') {
    const snip = searchTarget.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    updated = original.replace(/\r\n/g, '\n').replace(snip, replaceTarget.replace(/\n$/, ''));
    const before = original.replace(/\r\n/g, '\n').indexOf(snip);
    startLine = original.slice(0, before).split('\n').length;
    removedLines = snip.split('\n').length;
    removedPreview = snip.length > 300 ? snip.slice(0, 300) + '\n…(truncated)' : snip;
  } else {
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const newLines = replaceTarget === '' ? [] : replaceTarget.replace(/\n$/, '').split('\n');
    updated = [...fileLines.slice(0, match.start), ...newLines, ...fileLines.slice(match.end + 1)].join('\n');
    startLine = match.start + 1;
    removedLines = match.end - match.start + 1;
    const removed = fileLines.slice(match.start, match.end + 1).join('\n');
    removedPreview = removed.length > 300 ? removed.slice(0, 300) + '\n…(truncated)' : removed;
  }

  if (updated.trim() === '' && original.trim() !== '') {
    return { success: false, output: 'SAFETY ABORT: replacement would produce an empty file.' };
  }

  try {
    const backupDir = path.join(workspacePath, '.fluxo', 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    fs.writeFileSync(path.join(backupDir, `${path.basename(fp)}_${ts}.bak`), original, 'utf-8');
  } catch { /* non-fatal */ }

  fs.writeFileSync(fp, updated, 'utf-8');

  const matchNote = match.kind === 'fuzzy' ? ` [fuzzy match, line ${startLine}]` : ` [exact match, line ${startLine}]`;
  const diffBlock = buildDiffBlock(searchTarget, replaceTarget);
  return {
    success: true,
    output: `${diffBlock}\n\n**${targetPath}** — ${removedLines} line${removedLines !== 1 ? 's' : ''} replaced.${matchNote}\n\nCambio aplicado en el editor. Revisa el Diff arriba y presiona Ctrl+S en el archivo para guardar.\n\nEDICIÓN EXITOSA — Si la tarea no está completa, llama la siguiente herramienta.`,
  };
}
