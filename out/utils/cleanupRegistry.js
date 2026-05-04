"use strict";
// ─── Orphaned-Worktree Auto-Cleanup (v8.27.0 — Phase 3.3) ───────────────────
//
// Background janitor that runs once per VS Code activation. Scans
// .fluxo/worktrees/ and destroys any worktree directory that does NOT match
// the currently-active branch recorded in .fluxo/active_worktree.json.
//
// Why this exists: prior versions (v8.18.x onward) generally clean up worktrees
// on `exit_worktree(action='discard'|'merge')`, but the discard path can leave
// residue when:
//   • VS Code is killed mid-task (Ctrl+C, OS reboot, extension host crash) —
//     the worktree directory survives but the active_worktree.json was
//     overwritten by a newer task before cleanup ran.
//   • A `git worktree remove` failed silently because the worktree was locked
//     or contained uncommitted changes from a partial WIP commit.
//   • Two VS Code windows operated on the same repo and one of them created
//     a worktree the other never knew about (no DAG/mutex coordination
//     between processes outside merge.lock).
//
// Over time these orphans accumulate inside .fluxo/worktrees/ and consume
// disk + clutter `git worktree list` output. This routine is idempotent and
// silent: if there are no orphans, nothing happens; failures during cleanup
// are swallowed so a stuck worktree never blocks extension activation.
//
// Order of operations per orphan:
//   1. `git worktree remove --force <path>`   — releases the worktree slot
//                                                from git's bookkeeping.
//   2. `git worktree prune`                   — sweeps any stale entries
//                                                left by previous failed
//                                                removes.
//   3. `git branch -D <branch>`               — deletes the local branch
//                                                the orphan was attached to.
//   4. fs.rmSync(<path>, recursive, force)    — last-resort filesystem
//                                                cleanup if step 1 left the
//                                                directory behind.
// Each step's failure is logged to console.error but does NOT abort the
// loop — the next orphan still gets a try.
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
exports.cleanupOrphanedWorktrees = cleanupOrphanedWorktrees;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const cp = __importStar(require("child_process"));
const STATE_FILE_RELATIVE = path.join('.fluxo', 'active_worktree.json');
const WORKTREES_DIR_RELATIVE = path.join('.fluxo', 'worktrees');
function readActiveBranch(workspacePath) {
    const stateFile = path.join(workspacePath, STATE_FILE_RELATIVE);
    if (!fs.existsSync(stateFile)) {
        return null;
    }
    try {
        const raw = fs.readFileSync(stateFile, 'utf-8');
        const parsed = JSON.parse(raw);
        return typeof parsed?.branchName === 'string' && parsed.branchName.trim()
            ? parsed.branchName.trim()
            : null;
    }
    catch {
        // Corrupt JSON — treat as "no active worktree" so cleanup proceeds for
        // all directories. A clean session start will rewrite the file.
        return null;
    }
}
function destroyWorktree(workspacePath, branchName, worktreePath) {
    // Step 1 — git worktree remove --force. The --force flag is required
    // because the orphan typically has uncommitted residue from a crashed
    // session; without it git refuses with "contains modified or untracked
    // files".
    try {
        cp.execSync(`git worktree remove --force "${worktreePath}"`, {
            cwd: workspacePath,
            stdio: 'pipe',
            timeout: 15000,
        });
    }
    catch (err) {
        console.error(`[Fluxo Cleanup] git worktree remove failed for "${branchName}": ${err?.message ?? err}`);
    }
    // Step 2 — git worktree prune. Sweeps stale .git/worktrees/<name>
    // entries that the remove may have left behind (or that an earlier
    // failed remove created).
    try {
        cp.execSync('git worktree prune', {
            cwd: workspacePath,
            stdio: 'pipe',
            timeout: 10000,
        });
    }
    catch (err) {
        console.error(`[Fluxo Cleanup] git worktree prune failed: ${err?.message ?? err}`);
    }
    // Step 3 — git branch -D. The orphan branch is local-only (the engine
    // never publishes worktree branches to a remote); -D bypasses the
    // "branch not fully merged" check which would otherwise block deletion
    // because the branch contains the unmerged anchor commit.
    try {
        cp.execSync(`git branch -D "${branchName}"`, {
            cwd: workspacePath,
            stdio: 'pipe',
            timeout: 10000,
        });
    }
    catch (err) {
        // Common path: branch already gone because `git worktree remove --force`
        // can take it with the worktree on some git versions. Not an error.
        if (!String(err?.message ?? '').includes('not found')) {
            console.error(`[Fluxo Cleanup] git branch -D failed for "${branchName}": ${err?.message ?? err}`);
        }
    }
    // Step 4 — defensive fs cleanup. If any of the above left the directory
    // on disk (which happens when git's bookkeeping recovered but the actual
    // tree didn't get unlinked, e.g. on Windows where a file handle is still
    // held), remove the tree directly. fs.rmSync with recursive+force does
    // not throw on missing.
    try {
        if (fs.existsSync(worktreePath)) {
            fs.rmSync(worktreePath, { recursive: true, force: true, maxRetries: 3 });
        }
    }
    catch (err) {
        console.error(`[Fluxo Cleanup] fs.rmSync fallback failed for "${worktreePath}": ${err?.message ?? err}`);
    }
}
/**
 * Scan .fluxo/worktrees/ and destroy every directory whose name does NOT
 * match the active worktree recorded in .fluxo/active_worktree.json.
 * Idempotent and silent: zero orphans → no-op; failures per orphan are
 * isolated so one stuck worktree never blocks the rest.
 *
 * Returns the list of destroyed orphan branch names so the caller can log
 * the event for telemetry. Returns [] when the workspace has no .fluxo
 * directory or no worktrees subdirectory yet.
 */
function cleanupOrphanedWorktrees(workspacePath) {
    if (!workspacePath) {
        return [];
    }
    const worktreesDir = path.join(workspacePath, WORKTREES_DIR_RELATIVE);
    if (!fs.existsSync(worktreesDir)) {
        return [];
    }
    // Sanity: only run if we are inside a git repo. Outside of one, all the
    // git commands below would fail and spam stderr — the activation hook
    // can fire on workspaces that have a stray .fluxo/ leftover from a copy.
    try {
        cp.execSync('git rev-parse --is-inside-work-tree', {
            cwd: workspacePath,
            stdio: 'pipe',
            timeout: 5000,
        });
    }
    catch {
        return [];
    }
    const activeBranch = readActiveBranch(workspacePath);
    let entries;
    try {
        entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    const destroyed = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const branchName = entry.name;
        if (activeBranch && branchName === activeBranch) {
            continue;
        }
        const worktreePath = path.join(worktreesDir, branchName);
        destroyWorktree(workspacePath, branchName, worktreePath);
        destroyed.push(branchName);
    }
    return destroyed;
}
//# sourceMappingURL=cleanupRegistry.js.map