// Powered by Fluxo Tech AI — https://fluxotechai.com
import * as fs   from 'fs';
import * as path from 'path';
import * as cp   from 'child_process';
import { NativeTool, ToolResult } from '../shared';

export const TOOL_DEF: NativeTool = {
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

export function execute(args: Record<string, any>, workspacePath: string): ToolResult {
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

  let state: { branchName: string; worktreePath: string };
  try {
    state = JSON.parse(fs.readFileSync(stateFilePath, 'utf-8'));
  } catch {
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
    } catch { /* worktree dir may already be missing — continue to prune */ }
    try { cp.execSync('git worktree prune',          { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { cp.execSync(`git branch -D "${branchName}"`, { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

    return {
      success: true,
      output:
        `🗑️ WORKTREE DISCARDED — Sandbox deleted cleanly.\n\n` +
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
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    return {
      success: false,
      output:
        `ExitWorktree (merge): Failed to commit changes in worktree:\n${stderr}\n\n` +
        `Fix the issue inside the worktree, then retry. Or call exit_worktree with action='discard' to abort.`,
    };
  }

  // Step 2 — merge worktree branch into the main workspace's current branch
  // v8.17.4: on merge failure the engine takes BOTH recovery actions itself —
  // git merge --abort to clear the dirty MERGING state, then a full discard
  // (worktree remove + branch -D + state file unlink). v8.17.3 left the agent
  // a "discard the worktree" instruction; in dogfooding the @coder panicked
  // and tried to "fix" the conflict with raw git instead. v8.17.4 removes the
  // choice — the engine cleans up atomically and tells the agent to end its
  // turn so the @manager can reschedule the task.
  try {
    cp.execSync(
      `git merge "${branchName}" --no-ff -m "Merge worktree '${branchName}': ${commitMsg}"`,
      { cwd: workspacePath, stdio: 'pipe' }
    );
  } catch (e: any) {
    const stderr = (e.stderr?.toString() || e.message || '').slice(0, 400);
    // (a) Abort the in-flight merge so the workspace is no longer in MERGING state.
    try { cp.execSync('git merge --abort',                  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* nothing to abort */ }
    // (b) Auto-discard the worktree — same operations the action='discard' branch runs.
    try { cp.execSync(`git worktree remove --force "${worktreePath}"`, { cwd: workspacePath, stdio: 'pipe' }); } catch { /* worktree dir may already be gone */ }
    try { cp.execSync('git worktree prune',                  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { cp.execSync(`git branch -D "${branchName}"`,       { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
    try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

    return {
      success: false,
      output:
        `[MERGE CONFLICT] Codebase collision detected. The worktree was ` +
        `automatically discarded by the engine. End your turn immediately so the ` +
        `Manager can reschedule this task.\n\n` +
        `Underlying git output (first 400 chars):\n${stderr}`,
    };
  }

  // Step 3 — cleanup worktree & branch
  try { cp.execSync(`git worktree remove "${worktreePath}"`,  { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { cp.execSync('git worktree prune',                      { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { cp.execSync(`git branch -d "${branchName}"`,           { cwd: workspacePath, stdio: 'pipe' }); } catch { /* non-fatal */ }
  try { fs.unlinkSync(stateFilePath); } catch { /* non-fatal */ }

  return {
    success: true,
    output:
      `✅ WORKTREE MERGED — Changes integrated into main.\n\n` +
      `Branch '${branchName}' merged and cleaned up.\n` +
      `All changes are now live in the workspace. Run npm run build to confirm.`,
  };
}
