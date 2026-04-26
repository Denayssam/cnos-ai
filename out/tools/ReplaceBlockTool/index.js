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
                path: { type: 'string', description: 'File path relative to workspace root.' },
                target_snippet: { type: 'string', description: 'The text block to find and replace. Must be unique in the file. Copy from read_file output — whitespace differences are tolerated via fuzzy matching.' },
                new_content: { type: 'string', description: 'Text to insert in place of target_snippet. Use empty string "" to delete the block.' },
                healing_mode: { type: 'boolean', description: 'Set to true ONLY when fixing an already-broken file (syntax error, unbalanced braces, AST corruption). Disables brace-balance and AST guards.' },
            },
            required: ['path', 'target_snippet', 'new_content'],
        },
    },
};
// ─── Fuzzy Matching ───────────────────────────────────────────────────────────
function normalizeLine(line) {
    return line.trim().replace(/\s+/g, ' ');
}
/**
 * Locate target_snippet inside fileContent.
 * Fast path: exact string match (1 occurrence).
 * Fuzzy path: line-by-line comparison after whitespace normalization.
 * Returns 'ambiguous' if > 1 strict matches are found (don't fall through to fuzzy).
 */
function findBlock(fileContent, snippet) {
    // Normalize CRLF in both so mixed line-endings don't break matching
    const content = fileContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const snip = snippet.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // Fast path — exact string match
    const strictOccurrences = content.split(snip).length - 1;
    if (strictOccurrences === 1) {
        return { kind: 'strict' };
    }
    if (strictOccurrences > 1) {
        return { kind: 'ambiguous', count: strictOccurrences };
    }
    // Fuzzy path — line-by-line normalized comparison
    const fileLines = content.split('\n');
    const rawSnipLines = snip.split('\n');
    // Strip leading/trailing blank-only lines from snippet (LLM multiline string artifacts)
    let si = 0, ei = rawSnipLines.length - 1;
    while (si <= ei && rawSnipLines[si].trim() === '') {
        si++;
    }
    while (ei >= si && rawSnipLines[ei].trim() === '') {
        ei--;
    }
    const snippetLines = rawSnipLines.slice(si, ei + 1);
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
// ─── Tool Executor ────────────────────────────────────────────────────────────
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
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
    let updated;
    let removedPreviewText;
    let removedLineCount;
    let matchStartLine;
    let matchEndLine;
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
    }
    else {
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
        const JS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
        const JSX_EXTENSIONS = ['.tsx', '.jsx'];
        const fileExt = path.extname(fp).toLowerCase();
        if (JS_EXTENSIONS.includes(fileExt)) {
            const openCount = (updated.match(/\{/g) || []).length;
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
            const jsxBalance = (code) => {
                const opens = (code.match(/<[A-Za-z]/g) || []).length;
                const closes = (code.match(/<\/[A-Za-z]/g) || []).length;
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
    }
    catch { /* non-fatal */ }
    fs.writeFileSync(fp, updated, 'utf-8');
    const matchNote = match.kind === 'fuzzy'
        ? ` [fuzzy match: whitespace-normalized, lines ${matchStartLine}–${matchEndLine}]`
        : ` [exact match, lines ${matchStartLine}–${matchEndLine}]`;
    return {
        success: true,
        output: `replace_block: ${args.path} — 1 block replaced (${removedLineCount} line${removedLineCount !== 1 ? 's' : ''}).${matchNote}\n\nBLOCK REMOVED:\n${removedPreviewText}\n\nEDICIÓN EXITOSA — Verifica que el bloque eliminado es el correcto. Si la tarea no está completa, llama la SIGUIENTE herramienta ahora.`,
    };
}
//# sourceMappingURL=index.js.map