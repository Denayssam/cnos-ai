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
// Powered by Fluxo Tech AI — https://fluxotechai.com
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
exports.TOOL_DEF = {
    type: 'function',
    function: {
        name: 'enter_worktree',
        description: `Create an isolated git worktree sandbox for high-risk refactoring.
Use this BEFORE any operation that touches >50 lines or modifies multiple files simultaneously.
The worktree is a full checkout of the current HEAD on a fresh branch — edits there CANNOT corrupt the user's production code on main.

WORKFLOW:
1. Call enter_worktree → get back the worktree path.
2. Perform ALL edits using that path as the root (e.g. worktreePath/src/App.tsx).
3. Run npm run build inside the worktree to verify.
4. Call exit_worktree with action='merge' on success, or action='discard' to abort cleanly.

RULE: Never attempt to work in two worktrees simultaneously.`,
        parameters: {
            type: 'object',
            properties: {
                branch_name: {
                    type: 'string',
                    description: 'Optional branch name (e.g. "refactor-auth"). Auto-generated from timestamp if omitted.',
                },
                reason: {
                    type: 'string',
                    description: 'One-sentence description of why isolation is needed (shown to the user).',
                },
            },
            required: ['reason'],
        },
    },
};
const STATE_RELATIVE = path.join('.fluxo', 'active_worktree.json');
function execute(args, workspacePath) {
    // ── Validate git repo ─────────────────────────────────────────────────────
    try {
        cp.execSync('git rev-parse --is-inside-work-tree', { cwd: workspacePath, stdio: 'pipe' });
    }
    catch {
        return {
            success: false,
            output: 'EnterWorktree: This workspace is not a git repository. git worktree requires git init.',
        };
    }
    // ── Guard: one worktree at a time ─────────────────────────────────────────
    const stateFilePath = path.join(workspacePath, STATE_RELATIVE);
    if (fs.existsSync(stateFilePath)) {
        try {
            const existing = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
            return {
                success: false,
                output: `EnterWorktree: A worktree is already active ('${existing.branchName}'). ` +
                    `Call exit_worktree with action='merge' or action='discard' before creating a new one.`,
            };
        }
        catch { /* corrupted state file — proceed and overwrite */ }
    }
    // ── Resolve names & paths ─────────────────────────────────────────────────
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rawBranch = args.branch_name || `fluxo-wt-${timestamp}`;
    const branchName = rawBranch.replace(/[^a-zA-Z0-9-_]/g, '-');
    const worktreePath = path.join(workspacePath, '.fluxo', 'worktrees', branchName);
    const reason = String(args.reason || 'High-risk refactoring');
    // ── Create worktree ────────────────────────────────────────────────────────
    try {
        fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    }
    catch (e) {
        return { success: false, output: `EnterWorktree: Could not create worktree parent directory: ${e.message}` };
    }
    try {
        cp.execSync(`git worktree add "${worktreePath}" -b "${branchName}"`, {
            cwd: workspacePath,
            stdio: 'pipe',
        });
    }
    catch (e) {
        const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
        return { success: false, output: `EnterWorktree: git worktree add failed:\n${stderr}` };
    }
    // ── Persist state ─────────────────────────────────────────────────────────
    try {
        fs.writeFileSync(stateFilePath, JSON.stringify({
            branchName,
            worktreePath,
            reason,
            createdAt: new Date().toISOString(),
        }, null, 2), 'utf-8');
    }
    catch { /* non-fatal */ }
    const relPath = path.relative(workspacePath, worktreePath).replace(/\\/g, '/');
    return {
        success: true,
        output: `✅ WORKTREE ACTIVE — Isolation sandbox created.\n\n` +
            `Branch:        ${branchName}\n` +
            `Worktree path: ${relPath}/\n` +
            `Reason:        ${reason}\n\n` +
            `PATH REDIRECT ACTIVE (v8.8.0):\n` +
            `• Continue using NORMAL relative paths (e.g. 'src/App.tsx').\n` +
            `• The engine automatically redirects ALL file operations to the worktree — no prefix needed.\n` +
            `• 'npm run build' will also run inside the worktree to verify your changes.\n` +
            `• When done → exit_worktree(action='merge') on success, exit_worktree(action='discard') to abort.`,
    };
}
//# sourceMappingURL=index.js.map