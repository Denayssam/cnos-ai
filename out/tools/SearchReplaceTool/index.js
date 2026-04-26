"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.TOOL_DEF = void 0;
exports.execute = execute;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const shared_1 = require("../shared");
exports.TOOL_DEF = {
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
                path: { type: 'string', description: 'File path relative to workspace root.' },
                search_snippet: { type: 'string', description: 'The EXACT code currently in the file that you want to replace. Include 2–3 surrounding lines of context to guarantee uniqueness.' },
                replace_snippet: { type: 'string', description: 'The NEW code that will replace search_snippet. Use empty string "" to delete the block.' },
            },
            required: ['path', 'search_snippet', 'replace_snippet'],
        },
    },
};
// ─── Fuzzy Matching (mirrors ReplaceBlockTool logic) ─────────────────────────
function normalizeLine(line) {
    return line.trim().replace(/\s+/g, ' ');
}
function findMatch(fileContent, snippet) {
    const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const snip = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const strictCount = content.split(snip).length - 1;
    if (strictCount === 1) {
        return { kind: 'strict' };
    }
    if (strictCount > 1) {
        return { kind: 'ambiguous', count: strictCount };
    }
    // Fuzzy: line-by-line normalized comparison
    const fileLines = content.split('\n');
    const rawSnip = snip.split('\n');
    let si = 0, ei = rawSnip.length - 1;
    while (si <= ei && rawSnip[si].trim() === '') {
        si++;
    }
    while (ei >= si && rawSnip[ei].trim() === '') {
        ei--;
    }
    const snippetLines = rawSnip.slice(si, ei + 1);
    if (snippetLines.length === 0) {
        return { kind: 'none' };
    }
    const snipNorm = snippetLines.map(normalizeLine);
    const n = snippetLines.length;
    const matches = [];
    outer: for (let i = 0; i <= fileLines.length - n; i++) {
        for (let j = 0; j < n; j++) {
            if (normalizeLine(fileLines[i + j]) !== snipNorm[j]) {
                continue outer;
            }
        }
        matches.push(i);
    }
    if (matches.length === 0) {
        return { kind: 'none' };
    }
    if (matches.length > 1) {
        return { kind: 'ambiguous', count: matches.length };
    }
    return { kind: 'fuzzy', start: matches[0], end: matches[0] + n - 1 };
}
// ─── Disk-based fallback executor (used when VS Code native edit is unavailable) ─
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
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
    let updated;
    let removedPreview;
    let removedLines;
    let startLine;
    if (match.kind === 'strict') {
        const snip = args.search_snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        updated = original.replace(/\r\n/g, '\n').replace(snip, args.replace_snippet.replace(/\n$/, ''));
        const before = original.replace(/\r\n/g, '\n').indexOf(snip);
        startLine = original.slice(0, before).split('\n').length;
        removedLines = snip.split('\n').length;
        removedPreview = snip.length > 300 ? snip.slice(0, 300) + '\n…(truncated)' : snip;
    }
    else {
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
    }
    catch { /* non-fatal */ }
    fs.writeFileSync(fp, updated, 'utf-8');
    const matchNote = match.kind === 'fuzzy' ? ` [fuzzy match, line ${startLine}]` : ` [exact match, line ${startLine}]`;
    return {
        success: true,
        output: `search_and_replace: ${args.path} — ${removedLines} line${removedLines !== 1 ? 's' : ''} replaced.${matchNote}\n\nBLOCK REMOVED:\n${removedPreview}\n\nEDICIÓN EXITOSA — Si la tarea no está completa, llama la siguiente herramienta.`,
    };
}
//# sourceMappingURL=index.js.map