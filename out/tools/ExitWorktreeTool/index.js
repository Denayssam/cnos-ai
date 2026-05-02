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
const gitSafety_1 = require("../../utils/gitSafety");
const dagController_1 = require("../../utils/dagController");
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
// ─── Canonical Repo Root Resolver (v8.18.1) ─────────────────────────────────
// In Phase 4 dogfooding, dagController.appendTask returned null because the
// resolved root was the worktree directory (which has no .fluxo/dag_state.json).
// `git rev-parse --show-toplevel` returns the canonical absolute path of the
// repository root from any subdirectory, including worktrees. We use it to
// guarantee that DAG operations (.fluxo/dag_state.json) always target the
// real project root, never a sandboxed worktree.
function resolveRepoRoot(cwdPath) {
    try {
        const out = cp.execSync('git rev-parse --show-toplevel', { cwd: cwdPath, stdio: ['pipe', 'pipe', 'ignore'] })
            .toString().trim();
        return out || cwdPath;
    }
    catch {
        return cwdPath;
    }
}
// ───────────────────────────────────────────────────────────────────────────
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
    // v8.18.0 (Phase 4): Sequential Merge Mutex + DAG Conflict Auto-Resolution.
    // The merge attempt now runs under a process-wide file lock (.fluxo/merge.lock)
    // so concurrent agents serialize at the git controller. On conflict failure
    // the engine still auto-aborts and discards (v8.17.4), but instead of just
    // telling the agent "task FAILED, manager reschedule", it dynamically injects
    // a HIGH PRIORITY conflict-resolution task into the live DAG with the
    // captured conflict context — the dispatcher will pick it up on the next
    // tick.
    const mutex = (0, gitSafety_1.acquireMergeMutex)(workspacePath, `worktree:${branchName}`);
    if (!mutex) {
        return {
            success: false,
            output: `ExitWorktree (merge): could not acquire .fluxo/merge.lock within 30s — ` +
                `another agent is currently merging. Wait for the in-flight merge to complete, ` +
                `then retry exit_worktree(action='merge').`,
        };
    }
    try {
        cp.execSync(`git merge "${branchName}" --no-ff -m "Merge worktree '${branchName}': ${commitMsg}"`, { cwd: workspacePath, stdio: 'pipe' });
    }
    catch (e) {
        const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
        // (a) Capture conflict context BEFORE we abort. Once the merge is aborted
        // the conflict markers vanish from main — we need the file list and a
        // snippet of the marker block while the workspace is still in MERGING.
        let conflictFiles = [];
        try {
            conflictFiles = cp.execSync('git diff --name-only --diff-filter=U', { cwd: workspacePath, stdio: 'pipe' })
                .toString().trim().split(/\r?\n/).filter(Boolean);
        }
        catch { /* no unmerged files reported — fall back to empty list */ }
        const conflictSnippets = [];
        for (const rel of conflictFiles.slice(0, 6)) {
            try {
                const raw = fs.readFileSync(path.join(workspacePath, rel), 'utf-8');
                const start = raw.indexOf('<<<<<<<');
                if (start >= 0) {
                    const slice = raw.slice(start, start + 1500);
                    conflictSnippets.push(`---\n**${rel}** (first conflict block):\n\`\`\`\n${slice}\n\`\`\``);
                }
            }
            catch { /* unreadable file — skip */ }
        }
        // (b) Abort the in-flight merge so the workspace is no longer in MERGING state.
        try {
            cp.execSync('git merge --abort', { cwd: workspacePath, stdio: 'pipe' });
        }
        catch { /* nothing to abort */ }
        // (c) Auto-discard the worktree — same operations the action='discard' branch runs.
        try {
            cp.execSync(`git worktree remove --force "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' });
        }
        catch { /* worktree dir may already be gone */ }
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
        // (d) Release mutex BEFORE we touch the DAG — keep the critical section tight.
        mutex.release();
        // (e) Dynamically inject a HIGH PRIORITY conflict-resolution task. The
        // dispatcher (Phase 2) will pick it up on the next tick once its parent
        // task has reached a terminal status (the dispatcher's lifecycle hook
        // marks the failed task FAILED right after this tool returns).
        // v8.18.1 — resolve the canonical repo root for DAG operations. In Phase 4
        // dogfooding, appendTask returned null because the path passed to it
        // resolved to a directory without .fluxo/dag_state.json (the worktree
        // sandbox or a relocated cwd). git rev-parse --show-toplevel always
        // returns the real repo root from anywhere inside the worktree tree.
        const repoRoot = resolveRepoRoot(workspacePath);
        const failedTask = (0, dagController_1.getCurrentInProgressTask)(repoRoot);
        const fileList = conflictFiles.length > 0 ? conflictFiles.join(', ') : 'unknown files';
        // depends_on is intentionally EMPTY so the dispatcher picks the conflict
        // task up on the next tick. Listing the failed parent here would block
        // the task forever — getReadyTasks only unblocks when parents are
        // COMPLETED, and the parent will be marked FAILED by the dispatcher's
        // lifecycle hook moments after this tool returns. The causal/audit link
        // to the parent is preserved verbatim in the description below.
        const dagInjected = (0, dagController_1.appendTask)(repoRoot, {
            idPrefix: 'conflict',
            agent_type: '@coder',
            depends_on: [],
            description: `URGENT: Resolve Git Merge Conflict in ${fileList}\n\n` +
                `[PRIORITY: HIGH — auto-injected by ExitWorktreeTool v8.18.0]\n\n` +
                (failedTask
                    ? `Parent task: ${failedTask.id} (${failedTask.description}) — its worktree branch '${branchName}' could not be merged into main due to codebase collisions. The engine has already aborted the merge and discarded the broken worktree. You are now starting from a clean main.\n\n`
                    : `A worktree merge for branch '${branchName}' failed due to codebase collisions. The engine has already aborted the merge and discarded the broken worktree. You are now starting from a clean main.\n\n`) +
                `RESOLUTION PROTOCOL — DO NOT skip steps:\n` +
                `1. Call get_repo_map first to regain spatial awareness of the workspace (the panoramic shield will block other tools until you do).\n` +
                `2. For EACH file listed above, call read_file to see its current state on main.\n` +
                `3. Reconstruct the changes from the parent task using the conflict snippets captured below — they show exactly which lines collided and what the parent task tried to introduce. The HEAD side (above =======) is what main has now; the branch side (below =======) is what the parent task wanted.\n` +
                `4. Mathematically resolve the logic: keep the side whose semantics are correct, or merge both if they are independent (different functions, different keys, etc.). Never just delete a side.\n` +
                `5. Apply each resolution as a unified-diff-precise search_and_replace (see UDIFF rule v8.17.3). Read each file before editing, copy verbatim.\n` +
                `6. Run npm run build (or the project's build command) to verify the resolution compiles.\n` +
                `7. End your turn cleanly — do NOT enter a worktree for this task; the resolution applies directly on main.\n\n` +
                (conflictSnippets.length > 0
                    ? `── CAPTURED CONFLICT SNIPPETS (pre-abort) ──\n${conflictSnippets.join('\n')}\n`
                    : `── No conflict snippets could be captured — inspect the files in the list directly. ──\n`) +
                `\n── git stderr (first 400 chars) ──\n${stderr}\n`,
        });
        const queuedNote = dagInjected
            ? ` New task '${dagInjected.id}' was queued in .fluxo/dag_state.json${failedTask ? ` (depends on ${failedTask.id})` : ''}.`
            : ' (DAG was not active — no follow-up task was queued; surface the conflict to the @manager directly.)';
        return {
            success: false,
            output: `[MERGE CONFLICT] A collision occurred. A priority conflict-resolution task ` +
                `has been queued in the DAG. Exit your turn immediately.${queuedNote}\n\n` +
                `Files in conflict: ${fileList}\n\n` +
                `Underlying git output (first 400 chars):\n${stderr}`,
        };
    }
    finally {
        // Belt-and-suspenders: if the merge succeeded we drop the mutex here too.
        // The catch path above already released it before injecting the DAG task.
        try {
            mutex.release();
        }
        catch { /* already released */ }
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