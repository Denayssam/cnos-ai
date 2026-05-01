import { execSync } from 'child_process';

// ─── Git Safety Utilities (v8.15.0 — The Time Machine) ───────────────────────

export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd, encoding: 'utf-8', timeout: 5000 });
    return out.trim().length > 0;
  } catch {
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
export function createSilentCheckpoint(taskId: string, cwd: string): void {
  // ── v8.16.2: Block checkpoints for invalid/analysis-only task IDs ────────────
  if (taskId.includes('MISSION-ANALYSIS-ONLY')) {
    return;
  }
  if (hasUncommittedChanges(cwd)) {
    execSync('git add .', { cwd, encoding: 'utf-8', timeout: 10000 });
    execSync(
      'git commit -m "WIP: Auto-saved human changes before agent task"',
      { cwd, encoding: 'utf-8', timeout: 10000 }
    );
  }
  const safe = taskId.replace(/['"\\]/g, '').slice(0, 60);
  execSync(`git commit --allow-empty -m "fluxo-auto-checkpoint: ${safe}"`, {
    cwd,
    encoding: 'utf-8',
    timeout: 10000,
  });
}

export function rollbackToLastCheckpoint(cwd: string): { success: boolean; output: string } {
  try {
    const out = execSync('git reset --hard HEAD~1', { cwd, encoding: 'utf-8', timeout: 15000 });
    return {
      success: true,
      output: `Rollback complete. Working tree restored to the state before the last agent checkpoint.\n${out.trim()}`,
    };
  } catch (err: any) {
    return {
      success: false,
      output: `Rollback failed: ${err.message ?? String(err)}`,
    };
  }
}
