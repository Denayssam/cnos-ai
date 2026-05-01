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

// Creates an empty anchor commit when the working tree is confirmed clean.
// This gives rollbackToLastCheckpoint() a fixed HEAD~1 to reset to, undoing
// all subsequent agent file edits in one atomic git reset --hard.
// Throws if uncommitted human changes are detected — mixing human and agent
// work into the same checkpoint would make the rollback boundary ambiguous.
export function createSilentCheckpoint(taskId: string, cwd: string): void {
  // ── v8.16.2: Block checkpoints for invalid/analysis-only task IDs ────────────
  if (taskId.includes('MISSION-ANALYSIS-ONLY')) {
    return;
  }
  if (hasUncommittedChanges(cwd)) {
    throw new Error(
      '[SYSTEM ALERT] Uncommitted human changes detected. MANDATORY: The human must commit or stash their work before the agent can safely operate.'
    );
  }
  const safe = taskId.replace(/['"\\]/g, '').slice(0, 60);
  execSync('git add .', { cwd, encoding: 'utf-8', timeout: 10000 });
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
