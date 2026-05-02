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
        name: 'exit_worktree',
        description: `Finalize the active git worktree created by enter_worktree.

action='merge'  → Commits all changes in the worktree and merges them into the main branch.
                  Use this when npm run build passes and the work is verified complete.
action='discard'→ Forcefully deletes the worktree branch without touching main.
                  Use this when the worktree is broken or the task is aborted.
                  The user's production code on main is NEVER affected by a discard.`,
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    description: "'merge' to integrate changes into main, 'discard' to delete the worktree cleanly.",
                },
                commit_message: {
                    type: 'string',
                    description: "Commit message summarising the changes. Required when action='merge'.",
                },
            },
            required: ['action'],
        },
    },
};
const STATE_RELATIVE = path.join('.fluxo', 'active_worktree.json');
function execute(args, workspacePath) {
    const action = String(args.action || '').toLowerCase();
    if (action !== 'merge' && action !== 'discard') {
        return { success: false, output: "ExitWorktree: 'action' must be 'merge' or 'discard'." };
    }
    // ── Load state ────────────────────────────────────────────────────────────
    const stateFilePath = path.join(workspacePath, STATE_RELATIVE);
    if (!fs.existsSync(stateFilePath)) {
        return {
            success: false,
            output: 'ExitWorktree: No active worktree found. Call enter_worktree first.',
        };
    }
    let state;
    try {
        state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
    }
    catch {
        return {
            success: false,
            output: 'ExitWorktree: Corrupted worktree state. Run "git worktree list" manually to inspect.',
        };
    }
    const { branchName, worktreePath } = state;
    // ── DISCARD ────────────────────────────────────────────────────────────────
    if (action === 'discard') {
        try {
            cp.execSync(`git worktree remove --force "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' });
        }
        catch { /* worktree dir may already be missing — continue to prune */ }
        try {
            cp.execSync('git worktree prune', { cwd: workspacePath, stdio: 'pipe' });
        }
        catch { /* non-fatal */ }
        try {
            cp.execSync(`git branch -D "${branchName}"`, { cwd: workspacePath, stdio: 'pipe' });
        }
        catch { /* non-fatal */ }
        try {
            fs.unlinkSync(stateFilePath);
        }
        catch { /* non-fatal */ }
        return {
            success: true,
            output: `🗑️ WORKTREE DISCARDED — Sandbox deleted cleanly.\n\n` +
                `Branch '${branchName}' and its worktree have been removed.\n` +
                `The main workspace is UNTOUCHED — production code is safe.`,
        };
    }
    // ── MERGE ─────────────────────────────────────────────────────────────────
    const commitMsg = String(args.commit_message || `Fluxo worktree: ${branchName}`)
        .replace(/"/g, "'"); // sanitise for shell
    // Step 1 — stage & commit inside the worktree
    try {
        cp.execSync('git add -A', { cwd: worktreePath, stdio: 'pipe' });
        const dirty = cp.execSync('git status --porcelain', { cwd: worktreePath, stdio: 'pipe' }).toString().trim();
        if (dirty) {
            cp.execSync(`git commit -m "${commitMsg}"`, { cwd: worktreePath, stdio: 'pipe' });
        }
    }
    catch (e) {
        const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
        return {
            success: false,
            output: `ExitWorktree (merge): Failed to commit changes in worktree:\n${stderr}\n\n` +
                `Fix the issue inside the worktree, then retry. Or call exit_worktree with action='discard' to abort.`,
        };
    }
    // Step 2 — merge worktree branch into the main workspace's current branch
    // v8.17.3: on merge failure (typically conflicts) we MUST NOT leave the main
    // workspace in a half-merged state. The agent has no reliable way to resolve
    // conflicts mid-loop, and a dirty MERGING state poisons every subsequent git
    // command in the session. Auto-abort here, return a single clean directive
    // the agent can act on (discard the worktree, surface to the manager).
    try {
        cp.execSync(`git merge "${branchName}" --no-ff -m "Merge worktree '${branchName}': ${commitMsg}"`, { cwd: workspacePath, stdio: 'pipe' });
    }
    catch (e) {
        const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
        let abortNote = '';
        try {
            cp.execSync('git merge --abort', { cwd: workspacePath, stdio: 'pipe' });
            abortNote = ' (git merge --abort succeeded — workspace restored to pre-merge state)';
        }
        catch (abortErr) {
            // Most often this means we never entered MERGING (e.g. fast-forward
            // refused for an unrelated reason). Either way the workspace is not
            // dirty with conflict markers — surface the original error and move on.
            abortNote = ' (no MERGING state to abort)';
        }
        return {
            success: false,
            output: `[MERGE CONFLICT] The merge failed due to codebase collisions. ` +
                `The merge was cleanly aborted${abortNote}. ` +
                `Exit the worktree with action='discard' and report the conflict to the Manager.\n\n` +
                `Underlying git output (first 400 chars):\n${stderr}`,
        };
    }
    // Step 3 — cleanup worktree & branch
    try {
        cp.execSync(`git worktree remove "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' });
    }
    catch { /* non-fatal */ }
    try {
        cp.execSync('git worktree prune', { cwd: workspacePath, stdio: 'pipe' });
    }
    catch { /* non-fatal */ }
    try {
        cp.execSync(`git branch -d "${branchName}"`, { cwd: workspacePath, stdio: 'pipe' });
    }
    catch { /* non-fatal */ }
    try {
        fs.unlinkSync(stateFilePath);
    }
    catch { /* non-fatal */ }
    return {
        success: true,
        output: `✅ WORKTREE MERGED — Changes integrated into main.\n\n` +
            `Branch '${branchName}' merged and cleaned up.\n` +
            `All changes are now live in the workspace. Run npm run build to confirm.`,
    };
}
//# sourceMappingURL=index.js.map