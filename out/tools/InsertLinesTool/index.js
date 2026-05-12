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
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const shared_1 = require("../shared");
const lockfile_1 = require("../../utils/lockfile");
const syntaxValidator_1 = require("../../utils/syntaxValidator");
// ─── insert_lines (v8.16.8 — The Precision Scalpel) ──────────────────────────
// Pure insertion tool: drops new content BEFORE a target line without removing
// or rewriting any existing code. Designed for "drop a fresh component into the
// file" workflows where replace_block / replace_lines fail because the LLM
// miscounts brackets in 50+ line JSX payloads.
//
// Use `at_line: <N+1>` (where N is the file's last line) to append at EOF, or
// `at_line: 1` to prepend. The tool still runs through the AST Syntax Shield
// so it cannot smuggle broken code into the file.
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'insert_lines',
        description: `Insert content BEFORE a 1-based line number. Nothing is removed.
Best for dropping a fresh component/function block into a file (replace_* would force counting brackets across 50+ JSX lines). read_file FIRST to get line count. at_line=1 prepends, at_line=(lastLine+1) appends.`,
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root.' },
                at_line: { type: 'number', description: '1-based line number BEFORE which the content is inserted. Use 1 to prepend, or (totalLines + 1) to append at EOF. Must come from a preceding read_file call — line numbers shift after every edit.' },
                content: { type: ['string', 'array'], description: 'The code to insert. May be a string or an Array of strings (one element per line) — the engine joins arrays with \\n. Do NOT add a trailing newline; the engine handles line endings. Empty content is rejected.' },
                healing_mode: { type: 'boolean', description: 'Set to true ONLY if you are inserting into an already-broken file as part of a syntax repair. Disables the AST Syntax Shield for this call.' },
                agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1"). Used by the File Lock Manager.' },
            },
            required: ['path', 'at_line', 'content'],
        },
    },
};
function execute(args, workspacePath) {
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
    if (!fs.existsSync(fp)) {
        return { success: false, output: `File not found: ${args.path}. Use list_dir or glob to verify the path.` };
    }
    const atLine = Number(args.at_line);
    if (!Number.isInteger(atLine) || atLine < 1) {
        return { success: false, output: `CRITICAL ERROR: at_line must be a positive integer >= 1 (received: ${args.at_line}). Call read_file first to get the current line count.` };
    }
    // ── Payload Normalizer (mirrors ReplaceLinesTool) ───────────────────────────
    if (Array.isArray(args.content)) {
        args.content = args.content.join('\n');
    }
    else if (args.content === null || args.content === undefined) {
        args.content = '';
    }
    else if (typeof args.content === 'object') {
        const vals = Object.values(args.content);
        args.content = vals.length > 0 ? vals.map(String).join('\n') : JSON.stringify(args.content);
    }
    if (typeof args.content !== 'string' || args.content === '') {
        return { success: false, output: 'CRITICAL ERROR: content must be a non-empty string or Array of strings. To delete lines instead of inserting, use replace_lines with new_content="".' };
    }
    const original = fs.readFileSync(fp, 'utf-8');
    const lines = original.split('\n');
    const totalLines = lines.length;
    if (atLine > totalLines + 1) {
        return { success: false, output: `CRITICAL ERROR: at_line (${atLine}) is past EOF + 1 (file has ${totalLines} lines, max valid at_line is ${totalLines + 1}). Call read_file to get the current line count.` };
    }
    // Backup to temp dir — never touches workspace or git tree
    try {
        const backupDir = path.join(os.tmpdir(), 'fluxo-backups');
        fs.mkdirSync(backupDir, { recursive: true });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupName = `${path.basename(fp)}_${timestamp}.bak`;
        fs.writeFileSync(path.join(backupDir, backupName), original, 'utf-8');
    }
    catch {
        // Non-fatal
    }
    const insertLines = args.content.replace(/\n$/, '').split('\n');
    const resultLines = [
        ...lines.slice(0, atLine - 1),
        ...insertLines,
        ...lines.slice(atLine - 1),
    ];
    const updated = resultLines.join('\n');
    // ── AST Syntax Validation — prevents inserting unparseable code ─────────────
    if (!args.healing_mode) {
        const _syntaxCheck = (0, syntaxValidator_1.checkSyntax)(fp, updated);
        if (!_syntaxCheck.ok) {
            return {
                success: false,
                output: `[SYNTAX ERROR DETECTED] The proposed insertion breaks the file syntax. Insert aborted.\n` +
                    `Error details:\n${_syntaxCheck.errors}\n\n` +
                    `Your inserted block is unbalanced (missing brace, broken JSX tag, unterminated string, etc.). ` +
                    `Review your content and retry. If the file was already broken before your insert, pass healing_mode: true.`,
            };
        }
    }
    const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';
    if (!lockfile_1.FileLockManager.acquireLock(fp, agentId)) {
        return {
            success: false,
            output: `SYSTEM LOCK: El archivo ${args.path} está siendo editado actualmente por otro agente de tu equipo. Espera o trabaja en otro archivo mientras se libera el cerrojo.`,
        };
    }
    try {
        fs.writeFileSync(fp, updated, 'utf-8');
    }
    finally {
        lockfile_1.FileLockManager.releaseLock(fp, agentId);
    }
    return {
        success: true,
        output: `insert_lines: ${args.path} — inserted ${insertLines.length} line${insertLines.length !== 1 ? 's' : ''} before line ${atLine} (file grew from ${totalLines} → ${resultLines.length} lines). No existing lines were modified or removed. If the task is not complete, call the NEXT tool now.`,
    };
}
//# sourceMappingURL=index.js.map