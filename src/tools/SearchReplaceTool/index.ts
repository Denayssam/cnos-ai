import * as fs from 'fs';
import * as path from 'path';
import { NativeTool, ToolResult, safePath } from '../shared';

export const TOOL_DEF: NativeTool = {
  type: 'function',
  function: {
    name: 'search_and_replace',
    description: `Surgical edit by contextual search — no line numbers needed.
Workflow: read_file FIRST → copy search_snippet VERBATIM (every space/tab/newline) → call. Use replace_snippet="" to delete.
For >50 line injections use insert_lines instead. On MATCH ERROR re-read the file (your snippet is wrong); never guess.`,
    parameters: {
      type: 'object',
      properties: {
        path:            { type: 'string', description: 'File path relative to workspace root.' },
        search_snippet:  { type: 'string', description: 'The EXACT code currently in the file that you want to replace. Include 2–3 surrounding lines of context to guarantee uniqueness.' },
        replace_snippet: { type: 'string', description: 'The NEW code that will replace search_snippet. Use empty string "" to delete the block.' },
        healing_mode:    { type: 'boolean', description: 'Set to true ONLY when the user explicitly authorized you to bypass the Sherlock Auditor (e.g. "fix the duplicate anyway", "I know about it, force the change"). Combined with the engine\'s user-override marker check, this lets the edit through even if Sherlock would otherwise flag REDUNDANT_DECLARATION. Quote the user\'s override phrase in your reasoning so the engine can verify.' },
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

// v8.34.0 — When MATCH ERROR fires, locate the file region whose first lines
// best match the LLM's hallucinated snippet (longest contiguous run of
// normalized-equal lines). Returns the 0-based start line of that region or
// null when no line of the snippet matches anything in the file. Used purely
// for guidance — never to mutate the file.
function findBestFuzzyCandidate(fileContent: string, snippet: string): number | null {
  const fileLines = fileContent.replace(/\r\n/g, '\n').split('\n');
  const snipLines = snippet
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map(normalizeLine)
    .filter(l => l !== '');
  if (snipLines.length === 0 || fileLines.length === 0) { return null; }

  let bestStart = -1;
  let bestRun = 0;
  for (let i = 0; i < fileLines.length; i++) {
    let run = 0;
    for (let j = 0; j < snipLines.length && i + j < fileLines.length; j++) {
      if (normalizeLine(fileLines[i + j]) === snipLines[j]) {
        run++;
      } else {
        break;
      }
    }
    if (run > bestRun) {
      bestRun = run;
      bestStart = i;
    }
  }
  return bestRun >= 1 ? bestStart : null;
}

function formatNumberedLines(lines: string[], startIndex: number): string {
  return lines
    .map((l, i) => `${(startIndex + i + 1).toString().padStart(4)}: ${l}`)
    .join('\n');
}

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
    // ── v8.34.0: Auto-Read on MATCH ERROR (Panic Recovery rampa #1) ───────────
    // Instead of telling the agent "call read_file and try again" (which burns
    // an iteration and frequently fails again because the LLM re-hallucinates
    // from training memory), the engine itself injects the relevant file
    // content into the error output. Sized to fit a 200-line head + a ±10
    // line window around the best fuzzy candidate, so even large files keep
    // the payload compact while giving the LLM verbatim text to copy from.
    const HEAD_LINES = 200;
    const FUZZY_RADIUS = 10;
    const fileLines = original.replace(/\r\n/g, '\n').split('\n');
    const snipLineCount = searchTarget.replace(/\r\n/g, '\n').split('\n').length;

    let context: string;
    if (fileLines.length <= HEAD_LINES + 50) {
      context = formatNumberedLines(fileLines, 0);
    } else {
      const headChunk = formatNumberedLines(fileLines.slice(0, HEAD_LINES), 0);
      const fuzzyStart = findBestFuzzyCandidate(original, searchTarget);

      let fuzzyChunk = '';
      if (fuzzyStart !== null && fuzzyStart >= HEAD_LINES) {
        const start = Math.max(0, fuzzyStart - FUZZY_RADIUS);
        const end = Math.min(fileLines.length, fuzzyStart + snipLineCount + FUZZY_RADIUS);
        fuzzyChunk =
          `\n\n--- Best fuzzy candidate near line ${fuzzyStart + 1} ` +
          `(rejected — too dissimilar from your snippet) ---\n` +
          formatNumberedLines(fileLines.slice(start, end), start);
      }
      context = headChunk + fuzzyChunk;
    }

    return {
      success: false,
      output:
        `MATCH ERROR — search_snippet not found in ${targetPath}.\n\n` +
        `[v8.34.0 Auto-Read] Current file content (use this to copy the verbatim snippet — ` +
        `your memory of this file is stale):\n\n` +
        context +
        `\n\nRe-call search_and_replace with a snippet copied character-for-character from ` +
        `the lines above. Do NOT guess. If you need to inject a wholly new block of code ` +
        `that does not yet exist in this file, use insert_lines instead.`,
    };
    // ─────────────────────────────────────────────────────────────────────────
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
