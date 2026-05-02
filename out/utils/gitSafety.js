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
exports.acquireMergeMutex = acquireMergeMutex;
exports.hasUncommittedChanges = hasUncommittedChanges;
exports.createSilentCheckpoint = createSilentCheckpoint;
exports.rollbackToLastCheckpoint = rollbackToLastCheckpoint;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
// ─── Git Safety Utilities (v8.15.0 — The Time Machine) ───────────────────────
// ─── Sequential Merge Mutex (v8.18.0 — Phase 4) ─────────────────────────────
// Cross-process file lock that serializes worktree merges into the main
// branch. Multiple parallel agents (or multiple VS Code windows operating on
// the same repo) calling exit_worktree(merge) at the same time would race on
// git's index — partial merges, lost commits, half-applied refs. The mutex
// queues them: the first agent through holds the lock, the rest busy-wait
// (with bounded retry) until the holder releases or the lock is detected as
// stale.
//
// Why a sync busy-wait: the entire ExitWorktreeTool.execute() runs as a
// synchronous call from the engine. We cannot await — we must block until
// the lock is acquired or the deadline passes. execSync already blocks the
// event loop end-to-end, so a brief Atomics.wait inside the same tool call
// has identical scheduling impact.
const MERGE_LOCK_RELATIVE = path.join('.fluxo', 'merge.lock');
const MERGE_LOCK_TIMEOUT = 30000; // ms — abandon if we cannot get the lock in 30 s
const MERGE_LOCK_STALE_MS = 60000; // ms — a lock older than 60 s is treated as orphaned
const MERGE_LOCK_POLL_MS = 100; // ms — sleep between acquisition retries
function syncSleep(ms) {
    // Atomics.wait blocks the event loop without spin-burning CPU.
    const sab = new SharedArrayBuffer(4);
    const view = new Int32Array(sab);
    Atomics.wait(view, 0, 0, ms);
}
function ensureLockDir(workspacePath) {
    fs.mkdirSync(path.join(workspacePath, '.fluxo'), { recursive: true });
}
function isStale(lockPath) {
    try {
        const stat = fs.statSync(lockPath);
        return Date.now() - stat.mtimeMs > MERGE_LOCK_STALE_MS;
    }
    catch {
        return false;
    }
}
/**
 * Acquire a process-wide (and cross-process) merge mutex by atomically
 * creating .fluxo/merge.lock. Blocks for up to MERGE_LOCK_TIMEOUT ms.
 * On timeout, returns null so the caller can decide whether to fail or retry.
 */
function acquireMergeMutex(workspacePath, holderId) {
    ensureLockDir(workspacePath);
    const lockPath = path.join(workspacePath, MERGE_LOCK_RELATIVE);
    const deadline = Date.now() + MERGE_LOCK_TIMEOUT;
    const payload = JSON.stringify({ holder: holderId, pid: process.pid, acquired_at: new Date().toISOString() });
    while (Date.now() < deadline) {
        try {
            // wx flag = create + exclusive — fails atomically if the file already exists.
            const fd = fs.openSync(lockPath, 'wx');
            fs.writeSync(fd, payload);
            fs.closeSync(fd);
            return {
                acquiredAt: Date.now(),
                release: () => {
                    try {
                        fs.unlinkSync(lockPath);
                    }
                    catch { /* lock already cleaned */ }
                },
            };
        }
        catch (err) {
            if (err.code !== 'EEXIST') {
                return null;
            }
            // Stale lock: orphaned by a previous run. Force-remove and retry.
            if (isStale(lockPath)) {
                try {
                    fs.unlinkSync(lockPath);
                }
                catch { /* race with another waker — re-loop */ }
                continue;
            }
            syncSleep(MERGE_LOCK_POLL_MS);
        }
    }
    return null;
}
// ─────────────────────────────────────────────────────────────────────────────
function hasUncommittedChanges(cwd) {
    try {
        const out = (0, child_process_1.execSync)('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 });
        return out.trim().length > 0;
    }
    catch {
        return false; // not a git repo or git unavailable — treat as clean
    }
}
// Creates an empty anchor commit so rollbackToLastCheckpoint() has a fixed
// HEAD~1 to reset to, undoing all subsequent agent file edits in one atomic
// git reset --hard.
//
// v8.16.7 — Smart Auto-Commit: if the working tree has uncommitted human
// changes, we no longer abort. Instead we auto-save them as a "WIP" commit
// FIRST, then layer the agent's anchor commit on top. If the agent later
// fails and we reset --hard HEAD~1, the human's WIP commit remains intact —
// their work is preserved, only the agent's edits are discarded.
function createSilentCheckpoint(taskId, cwd) {
    // ── v8.16.2: Block checkpoints for invalid/analysis-only task IDs ────────────
    if (taskId.includes('MISSION-ANALYSIS-ONLY')) {
        return;
    }
    if (hasUncommittedChanges(cwd)) {
        (0, child_process_1.execSync)('git add .', { cwd, encoding: 'utf-8', timeout: 10000 });
        (0, child_process_1.execSync)('git commit -m "WIP: Auto-saved human changes before agent task"', { cwd, encoding: 'utf-8', timeout: 10000 });
    }
    const safe = taskId.replace(/['"\\]/g, '').slice(0, 60);
    (0, child_process_1.execSync)(`git commit --allow-empty -m "fluxo-auto-checkpoint: ${safe}"`, {
        cwd,
        encoding: 'utf-8',
        timeout: 10000,
    });
}
function rollbackToLastCheckpoint(cwd) {
    try {
        const out = (0, child_process_1.execSync)('git reset --hard HEAD~1', { cwd, encoding: 'utf-8', timeout: 15000 });
        return {
            success: true,
            output: `Rollback complete. Working tree restored to the state before the last agent checkpoint.\n${out.trim()}`,
        };
    }
    catch (err) {
        return {
            success: false,
            output: `Rollback failed: ${err.message ?? String(err)}`,
        };
    }
}
//# sourceMappingURL=gitSafety.js.map