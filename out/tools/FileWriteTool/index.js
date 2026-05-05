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
const lockfile_1 = require("../../utils/lockfile");
const syntaxValidator_1 = require("../../utils/syntaxValidator");
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'write_file',
        description: 'Create a new file or fully overwrite an existing markdown/JSON/config artifact. REQUIRED for: new source files, .md documents (plans, reports, docs), JSON config, and any file inside .fluxo/. The planner MUST use this tool to produce .fluxo/IMPLEMENTATION_PLAN.md. For modifying existing source code (.ts/.tsx/.js/.jsx/.py), prefer edit_file or replace_symbol to avoid overwriting unrelated code.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'File path relative to workspace root.' },
                content: { type: 'string', description: 'Complete file content to write.' },
                agent_id: { type: 'string', description: 'Unique identifier of the calling agent (e.g. "coder-1", "designer-2"). Used by the File Lock Manager to track ownership. Required when running in parallel orchestration mode.' },
                healing_mode: { type: 'boolean', description: 'Set to true ONLY when intentionally writing a file that may have syntax issues, e.g., a partial template or already-broken file being repaired. Bypasses AST syntax validation.' },
            },
            required: ['path', 'content'],
        },
    },
};
function execute(args, workspacePath) {
    if (typeof args.content !== 'string' || args.content.trim() === '') {
        return { success: false, output: 'CRITICAL ERROR: "content" is missing or empty.' };
    }
    const fp = (0, shared_1.safePath)(workspacePath, args.path);
    const agentId = typeof args.agent_id === 'string' ? args.agent_id : 'agent';
    // ── Aider-style Overwrite Block (v8.25.0 — North Star) ──────────────────────
    // Hard-block: write_file may NEVER touch a file that already exists. Forces
    // the agent toward AST/diff editing tools (replace_block, replace_symbol,
    // replace_lines, search_and_replace, insert_lines) which surgically edit
    // existing files instead of nuking them. Aligns the swarm with Aider's
    // unified-diff discipline — no agent can quietly destroy unrelated code by
    // re-emitting an entire file with a "small fix" inside.
    // Position: after safePath() so the existsSync check uses the resolved
    // absolute path; before syntax validation and lock acquisition since both
    // are wasted work if we are about to reject.
    //
    // Whitelist: paths under `.fluxo/` are the engine's state space (the
    // @planner's IMPLEMENTATION_PLAN.md, the @manager's memory.md, the
    // improvements log, the active_worktree.json, the DAG state, the MCP
    // config, etc.). Those files are designed to be overwritten on every run
    // — they describe ephemeral engine state, not user code. The block exists
    // to protect USER source from blind overwrites, so the engine's own state
    // namespace is the natural exception. Match both POSIX (`.fluxo/`) and
    // Windows (`.fluxo\`) separators because the path normalization
    // middleware in agentEngine.ts (v8.5.2) emits forward slashes by default
    // but the engine still receives backslashes from a few legacy code paths.
    const _rawPath = String(args.path ?? '');
    const _isFluxoState = _rawPath.startsWith('.fluxo/') || _rawPath.startsWith('.fluxo\\');
    if (fs.existsSync(fp) && !_isFluxoState) {
        // ── v8.29.0: Size-Aware Write Block ─────────────────────────────────────
        // Small files (< 10 KB) are safe to overwrite in full — they are typically
        // configs, tiny utility modules, or new files under active construction
        // that have not grown large yet. The original Aider-style blanket block
        // (v8.25.0) was too strict for these cases and introduced unnecessary
        // friction when frontier models wanted to rewrite a 2 KB helper cleanly.
        // Large files (>= 10 KB) keep the hard block: at that size the risk of
        // silently nuking unrelated code is real and the surgical editing tools
        // (replace_block, search_and_replace, replace_symbol) are the right path.
        const _SIZE_THRESHOLD = 10240; // 10 KB
        try {
            const _existingSize = fs.statSync(fp).size;
            if (_existingSize >= _SIZE_THRESHOLD) {
                return {
                    success: false,
                    output: '[SYSTEM BLOCK] El archivo es demasiado grande. Prohibido usar write_file en archivos extensos. Debes usar replace_block o search_and_replace.',
                };
            }
            // File is small — allow the overwrite and fall through to the rest of execute().
        }
        catch {
            // statSync failed (race condition between existsSync and statSync on
            // Windows, or a symlink edge case). Fall through conservatively —
            // the write will proceed; a subsequent write error surfaces naturally.
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    // ── AST Syntax Validation (v8.14.0 — Syntax Shield) ─────────────────────────
    // Runs before lock acquisition — no point locking if the content is broken.
    // Skipped for non-TS/JS extensions (markdown, JSON, CSS, etc.) automatically.
    if (!args.healing_mode) {
        const _syntaxCheck = (0, syntaxValidator_1.checkSyntax)(fp, args.content);
        if (!_syntaxCheck.ok) {
            return {
                success: false,
                output: `[SYNTAX ERROR DETECTED] The proposed change breaks the file syntax. Write aborted.\n` +
                    `Error details:\n${_syntaxCheck.errors}\n\n` +
                    `You MUST review your code block and fix the syntax before retrying.`,
            };
        }
    }
    // ─────────────────────────────────────────────────────────────────────────────
    if (!lockfile_1.FileLockManager.acquireLock(fp, agentId)) {
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
    }
    finally {
        lockfile_1.FileLockManager.releaseLock(fp, agentId);
    }
}
//# sourceMappingURL=index.js.map